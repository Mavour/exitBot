import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SendTransactionError,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import DLMM from "@meteora-ag/dlmm";
import { CONFIG } from "./config";
import { ActivePosition } from "./position-fetcher";
import { autoSwapAfterExit, SwapResult } from "./jupiter-swap";
import { log, logError } from "./logger";
import { withRpcFallback } from "./rpc-manager";

const SEND_TX_TIMEOUT_MS = 30_000;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export type CloseAttribution =
  | "BOT_CONFIRMED"
  | "BOT_UNCONFIRMED_BUT_CLOSED"
  | "MANUAL_EXTERNAL";

export interface ExitResult {
  success: boolean;
  positionAddress: string;
  receivedX: string;
  receivedY: string;
  txSignatures: string[];
  dryRun: boolean;
  error?: string;
  swapResult: SwapResult | null;
  swapError?: string;
  postCloseErrors: string[];
  alreadyClosed?: boolean;
  closeAttribution?: CloseAttribution;
  closeReason?: string;
}

function buildPriorityFeeIx(): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: CONFIG.priorityFeeMicrolamports,
  });
}

function buildCUILimitIx(): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({
    units: CONFIG.computeUnitLimit,
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAlreadyClosedPositionError(err: unknown): boolean {
  const msg = errorMessage(err);
  return (
    /AccountOwnedByWrongProgram/i.test(msg) ||
    /owned by a different program than expected/i.test(msg) ||
    /custom program error:\s*0xbbf/i.test(msg) ||
    /Error Number:\s*3007/i.test(msg) ||
    msg.includes(SYSTEM_PROGRAM)
  );
}

function attachSubmittedSignature(err: Error, signature: string | undefined): Error {
  if (!signature) return err;
  const current = (err as any).submittedSignatures;
  const signatures = Array.isArray(current) ? current : [];
  if (!signatures.includes(signature)) signatures.push(signature);
  (err as any).submittedSignatures = signatures;
  return err;
}

function extractSubmittedSignatures(err: unknown): string[] {
  const signatures = (err as any)?.submittedSignatures;
  return Array.isArray(signatures) ? signatures.filter((s) => typeof s === "string") : [];
}

function isSendTransactionError(err: unknown): err is SendTransactionError {
  return (
    err instanceof SendTransactionError ||
    (typeof err === "object" &&
      err !== null &&
      typeof (err as { getLogs?: unknown }).getLogs === "function")
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function formatSendError(
  connection: Connection,
  err: unknown
): Promise<string> {
  const base = errorMessage(err);
  if (!isSendTransactionError(err)) return base;

  let logs = err.logs;
  let logsFetchError: string | undefined;
  if (!logs || logs.length === 0) {
    try {
      logs = await err.getLogs(connection);
    } catch (logsErr) {
      logsFetchError = errorMessage(logsErr);
    }
  }

  const detail = [
    base,
    logs && logs.length > 0
      ? `Full logs:\n${logs.join("\n")}`
      : "Full logs: []",
  ];

  if (logsFetchError) {
    detail.push(`getLogs failed: ${logsFetchError}`);
  }

  return detail.join("\n");
}

async function getActualReceivedAmount(
  connection: Connection,
  wallet: Keypair,
  mintX: string,
  mintY: string
): Promise<{ x: string; y: string; xDec: number; yDec: number } | null> {
  try {
    const fetchOne = async (mint: string) => {
      const accounts = await withRpcFallback(conn =>
        conn.getParsedTokenAccountsByOwner(wallet.publicKey, {
          mint: new PublicKey(mint),
        })
      );
      const acc = accounts.value[0]?.account.data.parsed.info.tokenAmount;
      if (!acc) return { amount: "0", decimals: 0 };
      return { amount: acc.amount, decimals: acc.decimals };
    };
    const [x, y] = await Promise.all([fetchOne(mintX), fetchOne(mintY)]);
    return {
      x: divDecimals(x.amount, x.decimals),
      y: divDecimals(y.amount, y.decimals),
      xDec: x.decimals,
      yDec: y.decimals,
    };
  } catch (err) {
    logError("Failed to fetch actual received amounts", err);
    return null;
  }
}

async function sendWithRetry(
  tx: Transaction,
  wallet: Keypair
): Promise<string> {
  const CB_PROGRAM = ComputeBudgetProgram.programId;
  const txHasComputeBudget = tx.instructions.some((ix) =>
    ix.programId.equals(CB_PROGRAM)
  );

  const allInstructions = txHasComputeBudget
    ? [...tx.instructions]
    : [buildCUILimitIx(), buildPriorityFeeIx(), ...tx.instructions];

  const maxRetries = 2;
  let lastErr: Error | undefined;
  const submittedSignatures: string[] = [];

  const isNonRetryable = (err: unknown): boolean => {
    const msg = errorMessage(err);
    return (
      msg.includes("duplicate instruction") ||
      msg.includes("already processed") ||
      msg.includes("Transaction simulation failed") ||
      msg.includes("invalid account data")
    );
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let sig: string | undefined;
    const blockhash = await withRpcFallback(conn => conn.getLatestBlockhash(CONFIG.commitment));
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: allInstructions,
    }).compileToV0Message();

    const versionedTx = new VersionedTransaction(message);
    versionedTx.sign([wallet]);

    try {
      sig = await withTimeout(
        withRpcFallback(conn =>
          conn.sendTransaction(versionedTx, {
            skipPreflight: false,
            maxRetries: 1,
          })
        ),
        SEND_TX_TIMEOUT_MS,
        `sendTransaction timed out after ${SEND_TX_TIMEOUT_MS}ms`
      );
      submittedSignatures.push(sig);
    } catch (sendErr) {
      const detailedError = await formatSendError(await withRpcFallback(async conn => conn), sendErr);
      lastErr = new Error(detailedError);
      (lastErr as any).submittedSignatures = [...submittedSignatures];
      if (isNonRetryable(sendErr)) {
        log("ERROR", `Transaction send failed (non-retryable)`, {
          attempt: attempt + 1,
          error: detailedError,
        });
        throw lastErr;
      }
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt);
        log("WARN", `Transaction send failed, retrying in ${delay}ms`, {
          attempt: attempt + 1,
          maxRetries,
          error: detailedError,
        });
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    }

    try {
      await withRpcFallback(conn => conn.confirmTransaction(
        {
          signature: sig,
          blockhash: blockhash.blockhash,
          lastValidBlockHeight: blockhash.lastValidBlockHeight,
        },
        CONFIG.commitment
      ));
      if (txHasComputeBudget) {
        log("INFO", `Tx confirmed (SDK compute budget used)`, { signature: sig });
      }
      return sig;
    } catch (confirmErr) {
      if (isNonRetryable(confirmErr)) {
        const errMsg = confirmErr instanceof Error ? confirmErr.message : String(confirmErr);
        log("ERROR", `Confirm failed (non-retryable)`, { error: errMsg });
        throw attachSubmittedSignature(confirmErr instanceof Error ? confirmErr : new Error(errMsg), sig);
      }
      const errMsg = confirmErr instanceof Error ? confirmErr.message : String(confirmErr);
      let status: Awaited<ReturnType<Connection["getSignatureStatus"]>> | null = null;
      try {
        status = await withRpcFallback(conn =>
          conn.getSignatureStatus(sig, { searchTransactionHistory: true })
        );
      } catch (statusErr) {
        lastErr = attachSubmittedSignature(statusErr instanceof Error ? statusErr : new Error(String(statusErr)), sig);
        (lastErr as any).submittedSignatures = [...submittedSignatures];
        if (attempt < maxRetries) {
          const delay = 1000 * Math.pow(2, attempt);
          log("WARN", `Signature status check failed, retrying in ${delay}ms`, {
            attempt: attempt + 1,
            maxRetries,
            signature: sig,
            error: lastErr.message,
          });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break;
      }
      const confStatus = status?.value?.confirmationStatus;
      if (confStatus === "confirmed" || confStatus === "finalized") {
        log("INFO", `Tx already confirmed despite confirm timeout`, {
          signature: sig,
          confirmationStatus: confStatus,
        });
        return sig;
      }
      lastErr = attachSubmittedSignature(confirmErr instanceof Error ? confirmErr : new Error(errMsg), sig);
      (lastErr as any).submittedSignatures = [...submittedSignatures];
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt);
        log("WARN", `Confirm failed, retrying in ${delay}ms`, {
          attempt: attempt + 1,
          maxRetries,
          error: lastErr.message,
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  const finalErr = lastErr || new Error(`Transaction failed after ${maxRetries} retries`);
  (finalErr as any).submittedSignatures = [...submittedSignatures];
  throw finalErr;
}

async function sendClaimTxs(
  txs: Transaction[],
  wallet: Keypair
): Promise<string[]> {
  const sigs: string[] = [];
  for (const tx of txs) {
    const sig = await sendWithRetry(tx, wallet);
    sigs.push(sig);
  }
  return sigs;
}

async function buildRemoveLiquidityTxs(
  position: ActivePosition,
  wallet: Keypair
): Promise<Transaction[]> {
  return withRpcFallback(async (conn) => {
    const dlmmPool = await DLMM.create(conn, position.poolAddress, {
      cluster: "mainnet-beta",
    });
    return dlmmPool.removeLiquidity({
      user: wallet.publicKey,
      position: position.positionPubkey,
      fromBinId: position.binRange.fromBinId,
      toBinId: position.binRange.toBinId,
      bps: new BN(10000),
      shouldClaimAndClose: true,
    });
  });
}

async function isPositionClosedByAccount(positionPubkey: PublicKey): Promise<boolean> {
  const accountInfo = await withRpcFallback(conn =>
    conn.getAccountInfo(positionPubkey, CONFIG.commitment)
  );
  const owner = accountInfo?.owner?.toBase58();
  return !accountInfo || owner === SYSTEM_PROGRAM;
}

async function isPositionMissingFromMeteora(position: ActivePosition, wallet: Keypair): Promise<boolean> {
  const url = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${wallet.publicKey.toBase58()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return false;
  const data = await res.json() as any;
  const pools = Array.isArray(data?.pools) ? data.pools : [];
  return !pools.some((pool: any) =>
    Array.isArray(pool?.listPositions) &&
    pool.listPositions.includes(position.positionPubkey.toBase58())
  );
}

async function verifyPositionClosed(position: ActivePosition, wallet: Keypair): Promise<boolean> {
  try {
    if (await isPositionClosedByAccount(position.positionPubkey)) return true;
  } catch (err) {
    log("WARN", "Position account close verification failed", {
      positionAddress: position.positionPubkey.toBase58(),
      error: errorMessage(err),
    });
  }

  try {
    if (await isPositionMissingFromMeteora(position, wallet)) return true;
  } catch (err) {
    log("WARN", "Meteora close verification failed", {
      positionAddress: position.positionPubkey.toBase58(),
      error: errorMessage(err),
    });
  }

  return false;
}

function markAlreadyClosed(
  result: ExitResult,
  attribution: CloseAttribution,
  reason: string
): void {
  result.alreadyClosed = true;
  result.closeAttribution = attribution;
  result.closeReason = reason;
  result.success = attribution !== "MANUAL_EXTERNAL";
  result.swapResult = {
    success: true,
    inputSymbol: "?",
    inputAmount: "0",
    outputAmount: "0",
    reason,
  };
}

function divDecimals(raw: string, decimals: number): string {
  const n = BigInt(raw);
  const d = 10n ** BigInt(decimals);
  const whole = n / d;
  const frac = n % d;
  const f = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return f ? `${whole}.${f}` : whole.toString();
}

function formatSolLamports(lamports: number): string {
  if (!Number.isFinite(lamports) || lamports <= 0) return "0";
  return (lamports / LAMPORTS_PER_SOL).toFixed(9).replace(/\.?0+$/, "");
}

async function getTransactionFeesLamports(
  signatures: string[]
): Promise<number> {
  try {
    const finality = CONFIG.commitment === "finalized" ? "finalized" : "confirmed";
    const transactions = await Promise.all(
      signatures.map(sig =>
        withRpcFallback(conn =>
          conn.getTransaction(sig, {
            commitment: finality,
            maxSupportedTransactionVersion: 0,
          })
        )
      )
    );
    return transactions.reduce((sum, tx) => sum + (tx?.meta?.fee ?? 0), 0);
  } catch (err) {
    log("WARN", "Failed to fetch transaction fees for native SOL received", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

async function runPostCloseAutoSwap(params: {
  receivedTokenMint: string;
  receivedTokenSymbol: string;
  wallet: Keypair;
  connection: Connection;
  dryRun: boolean;
  tokenDecimals?: number;
}): Promise<SwapResult> {
  const first = await autoSwapAfterExit({
    ...params,
    receivedAmount: "0",
  });

  if (params.dryRun) {
    return first;
  }

  log(first.success ? "EXIT" : "WARN", "Scheduling 30s residual token re-check", {
    mint: params.receivedTokenMint,
    symbol: params.receivedTokenSymbol,
    reason: first.reason,
    firstSwapSuccess: first.success,
    firstSwapTx: first.txSignature,
  });

  await new Promise((r) => setTimeout(r, 30000));

  const retry = await autoSwapAfterExit({
    ...params,
    receivedAmount: "0",
  });

  if (retry.success) {
    log("EXIT", "Post-close residual token check swapped remaining balance", {
      mint: params.receivedTokenMint,
      symbol: params.receivedTokenSymbol,
      tx: retry.txSignature,
      output: retry.outputAmount,
    });
    retry.reason = retry.reason || `Swapped remaining balance on 30s post-close check`;
    return retry;
  }

  const retryReason = retry.reason || "";
  const noResidualToken =
    retryReason.startsWith(`No ${params.receivedTokenSymbol} balance`) ||
    retryReason.includes("below $");

  if (first.success && noResidualToken) {
    log("EXIT", "Post-close residual token check found no swapable balance", {
      mint: params.receivedTokenMint,
      symbol: params.receivedTokenSymbol,
      reason: retry.reason,
      firstSwapTx: first.txSignature,
    });
    return first;
  }

  log("WARN", "Post-close residual token retry failed", {
    mint: params.receivedTokenMint,
    symbol: params.receivedTokenSymbol,
    firstReason: first.reason,
    retryReason: retry.reason,
  });

  retry.reason = `30s retry failed: ${retry.reason || first.reason || "swap incomplete"}`;
  return retry;
}

export async function executeFullExit(
  position: ActivePosition,
  wallet: Keypair,
  connection: Connection,
  dryRun: boolean
): Promise<ExitResult> {
  const posAddr = position.positionPubkey.toBase58();
  const result: ExitResult = {
    success: false,
    positionAddress: posAddr,
    receivedX: "0",
    receivedY: "0",
    txSignatures: [],
    dryRun,
    swapResult: null,
    postCloseErrors: [],
  };

  log("EXIT", `Starting exit for position ${posAddr}`, {
    dryRun,
    pool: position.poolAddress.toBase58(),
    binRange: position.binRange,
  });

  try {
    // Fix E: Pre-flight idempotency check — if position already closed on-chain, treat as success
    if (!dryRun) {
      try {
        if (await verifyPositionClosed(position, wallet)) {
          markAlreadyClosed(result, "MANUAL_EXTERNAL", "Position already closed externally/manual before bot exit");
          log("WARN", `Position ${posAddr} already closed before bot exit`, {
            closeAttribution: result.closeAttribution,
          });
          return result;
        }
      } catch (preflightErr) {
        log("WARN", `Pre-flight check failed, proceeding with exit`, {
          error: preflightErr instanceof Error ? preflightErr.message : String(preflightErr),
        });
      }
    }

    // Step 1 — Remove liquidity (claims fees + removes liq + closes position)
    log("EXIT", "Step 1: Removing liquidity with claim and close", { dryRun });
    const xMint = position.dlmmPool.tokenX.mint.address.toBase58();
    const yMint = position.dlmmPool.tokenY.mint.address.toBase58();
    const isXSolMint = xMint === SOL_MINT;
    const isYSolMint = yMint === SOL_MINT;
    let solBalanceBeforeRemove: number | null = null;

    if (dryRun) {
      log("EXIT", "DRY RUN: Would remove all liquidity (claim + close)", {
        totalX: position.totalXAmount,
        totalY: position.totalYAmount,
        fromBinId: position.binRange.fromBinId,
        toBinId: position.binRange.toBinId,
      });
      const xDec = position.dlmmPool.tokenX.mint.decimals;
      const yDec = position.dlmmPool.tokenY.mint.decimals;
      result.receivedX = divDecimals(position.totalXAmount, xDec);
      result.receivedY = divDecimals(position.totalYAmount, yDec);
    } else {
      if (isXSolMint || isYSolMint) {
        solBalanceBeforeRemove = await withRpcFallback(conn =>
          conn.getBalance(wallet.publicKey, CONFIG.commitment)
        );
      }

      const removeTxs = await buildRemoveLiquidityTxs(position, wallet);

      const sigs = await sendClaimTxs(removeTxs, wallet);
      result.txSignatures.push(...sigs);
      result.closeAttribution = "BOT_CONFIRMED";

      // Fix C: 5-second settle wait — prevents "zero balance" race when fetching actual received
      log("EXIT", `Liquidity removed (${sigs.length} tx), waiting 5s for chain to settle...`, {
        signatures: sigs,
      });
      await new Promise((r) => setTimeout(r, 5000));

      const actual = await getActualReceivedAmount(connection, wallet, xMint, yMint);
      if (actual) {
        result.receivedX = actual.x;
        result.receivedY = actual.y;
      } else {
        const xDec = position.dlmmPool.tokenX.mint.decimals;
        const yDec = position.dlmmPool.tokenY.mint.decimals;
        result.receivedX = divDecimals(position.totalXAmount, xDec);
        result.receivedY = divDecimals(position.totalYAmount, yDec);
      }

      if (solBalanceBeforeRemove !== null) {
        const solBalanceAfterRemove = await withRpcFallback(conn =>
          conn.getBalance(wallet.publicKey, CONFIG.commitment)
        );
        const txFeesLamports = await getTransactionFeesLamports(sigs);
        const nativeSolReceivedLamports = Math.max(
          solBalanceAfterRemove - solBalanceBeforeRemove + txFeesLamports,
          0
        );
        const nativeSolReceived = formatSolLamports(nativeSolReceivedLamports);
        if (isXSolMint) result.receivedX = nativeSolReceived;
        if (isYSolMint) result.receivedY = nativeSolReceived;
        log("EXIT", "Native SOL received from remove liquidity", {
          solBalanceBeforeRemove,
          solBalanceAfterRemove,
          txFeesLamports,
          nativeSolReceivedLamports,
          nativeSolReceived,
          solSide: isXSolMint ? "X" : "Y",
        });
      }

      log("EXIT", "Remove liquidity confirmed", {
        signatures: sigs,
        receivedX: result.receivedX,
        receivedY: result.receivedY,
        actualFetch: !!actual,
      });
    }

    // Step 2 — Auto-swap non-SOL token to SOL
    log("EXIT", "Step 2: Auto-swap residual tokens", { dryRun });

    const isXSol =
      position.baseTokenMint === SOL_MINT;
    const isYSol =
      position.quoteTokenMint === SOL_MINT;

    let swapTokenMint: string | null = null;
    let swapTokenSymbol: string | null = null;
    let swapTokenDecimals: number | undefined;

    if (!isXSol) {
      swapTokenMint = position.baseTokenMint;
      swapTokenSymbol = position.tokenXSymbol;
      swapTokenDecimals = position.dlmmPool.tokenX.mint.decimals;
    } else if (!isYSol) {
      swapTokenMint = position.quoteTokenMint;
      swapTokenSymbol = position.tokenYSymbol;
      swapTokenDecimals = position.dlmmPool.tokenY.mint.decimals;
    }

    if (swapTokenMint) {
      result.swapResult = await runPostCloseAutoSwap({
        receivedTokenMint: swapTokenMint,
        receivedTokenSymbol: swapTokenSymbol ?? "?",
        wallet,
        connection,
        dryRun,
        tokenDecimals: swapTokenDecimals,
      });
    } else {
      result.swapResult = {
        success: true,
        inputSymbol: "SOL",
        inputAmount: "0",
        outputAmount: "0",
        reason: "Both tokens are SOL/USDC, no swap needed",
      };
    }

    // Fix A: Decouple exit success from swap success.
    // Exit succeeds if liquidity was removed (tx confirmed on-chain).
    // Swap is a separate, optional cleanup step.
    const liquidityRemoved = result.txSignatures.length > 0 || dryRun;
    result.success = liquidityRemoved;
    if (liquidityRemoved && !result.closeAttribution) {
      result.closeAttribution = dryRun ? undefined : "BOT_CONFIRMED";
    }
    if (result.swapResult && !result.swapResult.success) {
      result.swapError = result.swapResult.reason || "swap incomplete";
      log("WARN", `Liquidity removed but swap incomplete`, {
        positionAddress: posAddr,
        swapReason: result.swapError,
      });
    }

    log("EXIT", `Exit complete for position ${posAddr}`, {
      success: result.success,
      liquidityRemoved,
      txCount: result.txSignatures.length,
      swapSuccess: result.swapResult?.success,
      swapReason: result.swapError,
      dryRun,
    });
  } catch (err) {
    for (const sig of extractSubmittedSignatures(err)) {
      if (!result.txSignatures.includes(sig)) result.txSignatures.push(sig);
    }

    if (!dryRun && (isAlreadyClosedPositionError(err) || result.txSignatures.length > 0)) {
      const closed = await verifyPositionClosed(position, wallet);
      if (closed) {
        const attribution: CloseAttribution =
          result.txSignatures.length > 0 ? "BOT_UNCONFIRMED_BUT_CLOSED" : "MANUAL_EXTERNAL";
        markAlreadyClosed(
          result,
          attribution,
          attribution === "BOT_UNCONFIRMED_BUT_CLOSED"
            ? "Position closed after bot submitted exit transaction, but confirmation was not observed"
            : "Position already closed externally/manual"
        );
        log(attribution === "MANUAL_EXTERNAL" ? "WARN" : "EXIT", "Position closed during failed exit attempt", {
          positionAddress: posAddr,
          closeAttribution: attribution,
          txSignatures: result.txSignatures,
          originalError: errorMessage(err),
        });
        return result;
      }
    }

    result.success = false;
    result.error = err instanceof Error ? err.message : String(err);
    logError(`Exit failed for position ${posAddr}`, err);
  }

  return result;
}
