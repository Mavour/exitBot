import {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { CONFIG } from "./config";
import { ActivePosition } from "./position-fetcher";
import { autoSwapAfterExit, SwapResult } from "./jupiter-swap";
import { log, logError } from "./logger";
import { withRpcFallback } from "./rpc-manager";

export interface ExitResult {
  success: boolean;
  positionAddress: string;
  receivedX: string;
  receivedY: string;
  txSignatures: string[];
  dryRun: boolean;
  error?: string;
  swapResult: SwapResult | null;
}

function buildPriorityFeeIx(): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: CONFIG.priorityFeeMicrolamports,
  });
}

async function sendWithRetry(
  connection: Connection,
  tx: Transaction,
  wallet: Keypair
): Promise<string> {
  const priorityIx = buildPriorityFeeIx();
  const allInstructions = [priorityIx, ...tx.instructions];

  const blockhash = await withRpcFallback(conn => conn.getLatestBlockhash(CONFIG.commitment));
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions: allInstructions,
  }).compileToV0Message();

  const versionedTx = new VersionedTransaction(message);
  versionedTx.sign([wallet]);

  const maxRetries = 3;
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const sig = await withRpcFallback(conn => conn.sendTransaction(versionedTx, {
        skipPreflight: false,
        maxRetries: 1,
      }));

      await withRpcFallback(conn => conn.confirmTransaction(
        {
          signature: sig,
          blockhash: blockhash.blockhash,
          lastValidBlockHeight: blockhash.lastValidBlockHeight,
        },
        CONFIG.commitment
      ));

      return sig;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt);
        log("WARN", `Transaction failed, retrying in ${delay}ms`, {
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
  };

  log("EXIT", `Starting exit for position ${posAddr}`, {
    dryRun,
    pool: position.poolAddress.toBase58(),
    binRange: position.binRange,
  });

  try {
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

      const xDec = position.dlmmPool.tokenX.mint.decimals;
      const yDec = position.dlmmPool.tokenY.mint.decimals;
      result.receivedX = divDecimals(position.totalXAmount, xDec);
      result.receivedY = divDecimals(position.totalYAmount, yDec);

      log("EXIT", "Remove liquidity confirmed", {
        signatures: sigs,
        receivedX: result.receivedX,
        receivedY: result.receivedY,
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

    if (!isXSol) {
      swapTokenMint = position.baseTokenMint;
      swapTokenSymbol = position.tokenXSymbol;
    } else if (!isYSol) {
      swapTokenMint = position.quoteTokenMint;
      swapTokenSymbol = position.tokenYSymbol;
    }

    if (swapTokenMint) {
      result.swapResult = await autoSwapAfterExit({
        receivedTokenMint: swapTokenMint,
        receivedTokenSymbol: swapTokenSymbol ?? "?",
        receivedAmount: "0",
        wallet,
        connection,
        dryRun,
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

    result.success = true;
    log("EXIT", `Exit complete for position ${posAddr}`, {
      success: true,
      txCount: result.txSignatures.length,
      swapResult: result.swapResult,
    });
  } catch (err) {
    result.success = false;
    result.error = err instanceof Error ? err.message : String(err);
    logError(`Exit failed for position ${posAddr}`, err);
  }

  return result;
}
