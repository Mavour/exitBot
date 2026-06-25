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
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { CONFIG } from "./config";
import { ActivePosition } from "./position-fetcher";
import { autoSwapAfterExit, SwapResult } from "./jupiter-swap";
import { log, logError } from "./logger";
import { withRpcFallback } from "./rpc-manager";

const SEND_TX_TIMEOUT_MS = 30_000;

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
  connection: Connection,
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
        connection.sendTransaction(versionedTx, {
          skipPreflight: false,
          maxRetries: 1,
        }),
        SEND_TX_TIMEOUT_MS,
        `sendTransaction timed out after ${SEND_TX_TIMEOUT_MS}ms`
      );
    } catch (sendErr) {
      const detailedError = await formatSendError(connection, sendErr);
      lastErr = new Error(detailedError);
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
        throw confirmErr instanceof Error ? confirmErr : new Error(errMsg);
      }
      const errMsg = confirmErr instanceof Error ? confirmErr.message : String(confirmErr);
      const status = await withRpcFallback(conn =>
        conn.getSignatureStatus(sig, { searchTransactionHistory: true })
      );
      const confStatus = status?.value?.confirmationStatus;
      if (confStatus === "confirmed" || confStatus === "finalized") {
        log("INFO", `Tx already confirmed despite confirm timeout`, {
          signature: sig,
          confirmationStatus: confStatus,
        });
        return sig;
      }
      lastErr = confirmErr instanceof Error ? confirmErr : new Error(errMsg);
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

  throw lastErr || new Error(`Transaction failed after ${maxRetries} retries`);
}

async function sendClaimTxs(
  connection: Connection,
  txs: Transaction[],
  wallet: Keypair
): Promise<string[]> {
  const sigs: string[] = [];
  for (const tx of txs) {
    const sig = await sendWithRetry(connection, tx, wallet);
    sigs.push(sig);
  }
  return sigs;
}

function divDecimals(raw: string, decimals: number): string {
  const n = BigInt(raw);
  const d = 10n ** BigInt(decimals);
  const whole = n / d;
  const frac = n % d;
  const f = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return f ? `${whole}.${f}` : whole.toString();
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
        const accountInfo = await withRpcFallback(conn =>
          conn.getAccountInfo(position.positionPubkey, CONFIG.commitment)
        );
        const owner = accountInfo?.owner?.toBase58();
        const SYSTEM_OWNER = "11111111111111111111111111111111";
        const isClosed = !accountInfo || owner === SYSTEM_OWNER;
        if (isClosed) {
          log("WARN", `Position ${posAddr} already closed on-chain, treating as success`, {
            owner: owner ?? "missing",
          });
          result.success = true;
          result.swapResult = {
            success: true,
            inputSymbol: "?",
            inputAmount: "0",
            outputAmount: "0",
            reason: "Position already closed on-chain",
          };
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
      const removeTxs = await position.dlmmPool.removeLiquidity({
        user: wallet.publicKey,
        position: position.positionPubkey,
        fromBinId: position.binRange.fromBinId,
        toBinId: position.binRange.toBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      const sigs = await sendClaimTxs(connection, removeTxs, wallet);
      result.txSignatures.push(...sigs);

      // Fix C: 5-second settle wait — prevents "zero balance" race when fetching actual received
      log("EXIT", `Liquidity removed (${sigs.length} tx), waiting 5s for chain to settle...`, {
        signatures: sigs,
      });
      await new Promise((r) => setTimeout(r, 5000));

      const xMint = position.dlmmPool.tokenX.mint.address.toBase58();
      const yMint = position.dlmmPool.tokenY.mint.address.toBase58();
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
      position.baseTokenMint ===
      "So11111111111111111111111111111111111111112";
    const isYSol =
      position.quoteTokenMint ===
      "So11111111111111111111111111111111111111112";

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
    result.success = false;
    result.error = err instanceof Error ? err.message : String(err);
    logError(`Exit failed for position ${posAddr}`, err);
  }

  return result;
}
