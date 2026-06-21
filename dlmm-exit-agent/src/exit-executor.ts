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
  error?: string;
}

function buildPriorityFeeInstruction(): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: CONFIG.priorityFeeMicrolamports,
  });
}

async function sendTransactionsWithPriorityFee(
  txs: Transaction[],
  wallet: Keypair,
  connection: Connection
): Promise<string[]> {
  const sigs: string[] = [];

  for (const tx of txs) {
    const priorityIx = buildPriorityFeeInstruction();
    const allInstructions = [priorityIx, ...tx.instructions];

    const blockhash = await connection.getLatestBlockhash(CONFIG.commitment);
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: allInstructions,
    }).compileToV0Message();

    const versionedTx = new VersionedTransaction(message);
    versionedTx.sign([wallet]);

    const sig = await connection.sendTransaction(versionedTx, {
      skipPreflight: false,
      maxRetries: 3,
    });

    await connection.confirmTransaction(
      {
        signature: sig,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      },
      CONFIG.commitment
    );

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
  };

  log("EXIT", `Starting exit for position ${posAddr}`, {
    dryRun,
    pool: position.poolAddress.toBase58(),
    binRange: position.binRange,
  });

  try {
    // Step 0: Get LbPosition data for operations that need it
    const lbPosition = await getPositionData(position, wallet);

    // Step 1: Claim all swap fees
    log("EXIT", "Step 1: Claiming swap fees", { dryRun });

    if (!dryRun) {
      const claimTxs = await position.dlmmPool.claimAllSwapFee({
        owner: wallet.publicKey,
        positions: [lbPosition],
      });

      for (const tx of claimTxs) {
        const sig = await sendAndConfirmTransaction(
          connection,
          tx,
          [wallet],
          {
            skipPreflight: false,
            commitment: CONFIG.commitment,
            maxRetries: 3,
          }
        );
        result.txSignatures.push(sig);
        log("EXIT", "Claim fees transaction confirmed", { signature: sig });
      }
    } else {
      log("EXIT", "DRY RUN: Skipping claim fees transaction", {
        unclaimedFeeX: position.unclaimedFeesX,
        unclaimedFeeY: position.unclaimedFeesY,
      });
    }

    result.claimedFeeX = position.unclaimedFeesX;
    result.claimedFeeY = position.unclaimedFeesY;

    // Step 2: Remove all liquidity
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

      const sigs = await sendTransactionsWithPriorityFee(
        removeTxs,
        wallet,
        connection
      );
      result.txSignatures.push(...sigs);

      result.receivedX = position.totalXAmount;
      result.receivedY = position.totalYAmount;

      log("EXIT", "Remove liquidity confirmed", {
        signatures: sigs,
        receivedX: result.receivedX,
        receivedY: result.receivedY,
      });
    }

    // Step 3: Close position
    log("EXIT", "Step 3: Closing position", { dryRun });

    if (!dryRun) {
      const closeTx = await position.dlmmPool.closePosition({
        owner: wallet.publicKey,
        position: lbPosition,
      });

      // closePosition returns Transaction (single), wrap in array for helper
      const sigs = await sendTransactionsWithPriorityFee(
        [closeTx],
        wallet,
        connection
      );
      result.txSignatures.push(...sigs);
      log("EXIT", "Close position confirmed", { signatures: sigs });
    } else {
      log("EXIT", "DRY RUN: Skipping close position transaction");
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
