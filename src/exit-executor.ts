import {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { CONFIG } from "./config";
import { ActivePosition } from "./position-fetcher";
import { log, logError } from "./logger";

export interface ExitResult {
  success: boolean;
  positionAddress: string;
  claimedFeeX: string;
  claimedFeeY: string;
  receivedX: string;
  receivedY: string;
  txSignatures: string[];
  dryRun: boolean;
  error?: string;
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

  const blockhash = await connection.getLatestBlockhash(CONFIG.commitment);
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
      const sig = await connection.sendTransaction(versionedTx, {
        skipPreflight: false,
        maxRetries: 1,
      });

      await connection.confirmTransaction(
        {
          signature: sig,
          blockhash: blockhash.blockhash,
          lastValidBlockHeight: blockhash.lastValidBlockHeight,
        },
        CONFIG.commitment
      );

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

async function getPositionData(position: ActivePosition, wallet: Keypair) {
  const positionsByUser = await position.dlmmPool.getPositionsByUserAndLbPair(
    wallet.publicKey
  );
  const posKey = position.positionPubkey.toBase58();
  const found = positionsByUser.userPositions.find(
    (p) => p.publicKey.toBase58() === posKey
  );
  if (!found) {
    throw new Error("Position data not found on chain");
  }
  return found;
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
    claimedFeeX: "0",
    claimedFeeY: "0",
    receivedX: "0",
    receivedY: "0",
    txSignatures: [],
    dryRun,
  };

  log("EXIT", `Starting exit for position ${posAddr}`, {
    dryRun,
    pool: position.poolAddress.toBase58(),
    binRange: position.binRange,
  });

  try {
    const lbPosition = await getPositionData(position, wallet);

    // Step 1 — Claim all swap fees
    log("EXIT", "Step 1: Claiming swap fees", { dryRun });

    if (!dryRun) {
      const claimTxs = await position.dlmmPool.claimAllSwapFee({
        owner: wallet.publicKey,
        positions: [lbPosition],
      });

      const sigs = await sendClaimTxs(connection, claimTxs, wallet);
      result.txSignatures.push(...sigs);
      log("EXIT", "Claim fees confirmed", { signatures: sigs });
    } else {
      log("EXIT", "DRY RUN: Would claim swap fees", {
        unclaimedFeeX: position.unclaimedFeesX,
        unclaimedFeeY: position.unclaimedFeesY,
      });
    }

    result.claimedFeeX = position.unclaimedFeesX;
    result.claimedFeeY = position.unclaimedFeesY;

    // Step 2 — Remove all liquidity
    log("EXIT", "Step 2: Removing all liquidity", { dryRun });

    if (dryRun) {
      log("EXIT", "DRY RUN: Would remove all liquidity", {
        totalX: position.totalXAmount,
        totalY: position.totalYAmount,
        fromBinId: position.binRange.fromBinId,
        toBinId: position.binRange.toBinId,
      });
      result.receivedX = position.totalXAmount;
      result.receivedY = position.totalYAmount;
    } else {
      const removeTxs = await position.dlmmPool.removeLiquidity({
        user: wallet.publicKey,
        position: position.positionPubkey,
        fromBinId: position.binRange.fromBinId,
        toBinId: position.binRange.toBinId,
        bps: new BN(10000),
        shouldClaimAndClose: false,
      });

      const sigs = await sendClaimTxs(connection, removeTxs, wallet);
      result.txSignatures.push(...sigs);

      result.receivedX = position.totalXAmount;
      result.receivedY = position.totalYAmount;

      log("EXIT", "Remove liquidity confirmed", {
        signatures: sigs,
        receivedX: result.receivedX,
        receivedY: result.receivedY,
      });
    }

    // Step 3 — Close position (use closePositionIfEmpty for safety)
    log("EXIT", "Step 3: Closing position", { dryRun });

    if (!dryRun) {
      const closeTx = await position.dlmmPool.closePosition({
        owner: wallet.publicKey,
        position: lbPosition,
      });

      const sig = await sendWithRetry(connection, closeTx, wallet);
      result.txSignatures.push(sig);
      log("EXIT", "Close position confirmed", { signature: sig });
    } else {
      log("EXIT", "DRY RUN: Would close position (recover rent SOL)");
    }

    result.success = true;
    log("EXIT", `Exit complete for position ${posAddr}`, {
      success: true,
      txCount: result.txSignatures.length,
    });
  } catch (err) {
    result.success = false;
    result.error = err instanceof Error ? err.message : String(err);
    logError(`Exit failed for position ${posAddr}`, err);
  }

  return result;
}
