import { Connection, Keypair } from "@solana/web3.js";
import { CONFIG } from "./config";
import { connection, wallet, logWalletInfo } from "./wallet";
import {
  fetchAllActivePositions,
  ActivePosition,
} from "./position-fetcher";
import {
  getCandles15m,
  getDexScreenerPairFromMints,
} from "./price-feed";
import { checkExitConditions } from "./indicators";
import { executeFullExit, ExitResult } from "./exit-executor";
import { log, logError } from "./logger";

const REQUIRED_CANDLES = CONFIG.rsiPeriod + CONFIG.bbPeriod + 20;

type PositionState = "MONITORING" | "EXIT_TRIGGERED" | "EXITING" | "EXITED";

interface TrackedPosition {
  position: ActivePosition;
  state: PositionState;
}

let isShuttingDown = false;
let pollCycle = 0;
const inFlight = new Set<string>();

function handleShutdown(): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log("INFO", "Agent stopped by user");
  process.exit(0);
}

export async function startMonitor(): Promise<void> {
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  await logWalletInfo();

  let trackedPositions: TrackedPosition[] = [];

  // Initial fetch
  const initialPositions = await fetchAllActivePositions(
    wallet.publicKey,
    connection
  );

  if (initialPositions.length === 0) {
    log("WARN", "No active positions found. Agent will idle and retry.");
  }

  // Resolve DexScreener pair addresses for each position
  for (const pos of initialPositions) {
    try {
      const pairAddr = await getDexScreenerPairFromMints(
        pos.baseTokenMint,
        pos.quoteTokenMint
      );
      pos.dexScreenerPairAddress = pairAddr;
    } catch (err) {
      logError(
        `Failed to resolve DexScreener pair for ${pos.baseTokenMint}`,
        err
      );
    }
  }

  trackedPositions = initialPositions.map((p) => ({
    position: p,
    state: "MONITORING" as PositionState,
  }));

  log("INFO", `Starting monitor loop every ${CONFIG.pollIntervalMs}ms`, {
    positionsCount: trackedPositions.length,
    dryRun: CONFIG.dryRun,
    rsiThreshold: CONFIG.rsiThreshold,
    bbPeriod: CONFIG.bbPeriod,
    bbStdDev: CONFIG.bbStdDev,
  });

  // Main loop
  const loop = async (): Promise<void> => {
    if (isShuttingDown) return;

    pollCycle++;
    log("INFO", `Poll cycle ${pollCycle}`, {
      trackedPositions: trackedPositions.filter(
        (t) => t.state !== "EXITED"
      ).length,
      inFlight: inFlight.size,
    });

    // Re-fetch position list every 10 cycles
    if (pollCycle % 10 === 0) {
      log("INFO", "Re-fetching position list");
      const freshPositions = await fetchAllActivePositions(
        wallet.publicKey,
        connection
      );

      // Resolve pair addresses for new positions
      for (const pos of freshPositions) {
        if (
          !trackedPositions.some(
            (t) => t.position.positionPubkey.toBase58() === pos.positionPubkey.toBase58()
          )
        ) {
          try {
            const pairAddr = await getDexScreenerPairFromMints(
              pos.baseTokenMint,
              pos.quoteTokenMint
            );
            pos.dexScreenerPairAddress = pairAddr;
          } catch (err) {
            logError(
              `Failed to resolve DexScreener pair for ${pos.baseTokenMint}`,
              err
            );
          }
        }
      }

      // Merge new positions
      const existingKeys = new Set(
        trackedPositions.map((t) => t.position.positionPubkey.toBase58())
      );
      for (const pos of freshPositions) {
        const key = pos.positionPubkey.toBase58();
        if (!existingKeys.has(key)) {
          trackedPositions.push({ position: pos, state: "MONITORING" });
          log("INFO", "New position detected", { positionAddress: key });
        }
      }

      // Remove positions that are no longer active (except EXITED ones)
      const freshKeys = new Set(
        freshPositions.map((p) => p.positionPubkey.toBase58())
      );
      trackedPositions = trackedPositions.filter((t) => {
        if (t.state === "EXITED") return false;
        const key = t.position.positionPubkey.toBase58();
        if (!freshKeys.has(key) && t.state === "MONITORING") {
          log("INFO", "Position no longer active, removing", {
            positionAddress: key,
          });
          return false;
        }
        return true;
      });
    }

    // Process each position
    for (const tracked of trackedPositions) {
      if (isShuttingDown) break;

      const pos = tracked.position;
      const posKey = pos.positionPubkey.toBase58();

      if (tracked.state === "EXITED") continue;

      if (tracked.state === "MONITORING") {
        if (inFlight.has(posKey)) continue;

        if (!pos.dexScreenerPairAddress) {
          log("WARN", "No DexScreener pair address for position, skipping", {
            positionAddress: posKey,
          });
          continue;
        }

        inFlight.add(posKey);

        try {
          const candles = await getCandles15m(
            pos.dexScreenerPairAddress,
            REQUIRED_CANDLES
          );

          const conditions = checkExitConditions(candles);

          log("INFO", `Position ${posKey.slice(0, 8)}...`, {
            rsi: conditions.rsi.toFixed(2),
            bbUpper: conditions.bb.upper.toFixed(8),
            bbMiddle: conditions.bb.middle.toFixed(8),
            bbLower: conditions.bb.lower.toFixed(8),
            price: conditions.price.toFixed(8),
            shouldExit: conditions.shouldExit,
          });

          if (conditions.shouldExit) {
            log("EXIT", "EXIT CONDITIONS MET", {
              positionAddress: posKey,
              rsi: conditions.rsi.toFixed(2),
              price: conditions.price.toFixed(8),
              bbUpper: conditions.bb.upper.toFixed(8),
              poolAddress: pos.poolAddress.toBase58(),
            });
            tracked.state = "EXIT_TRIGGERED";
          }
        } catch (err) {
          logError(
            `Failed to check conditions for position ${posKey}`,
            err
          );
        } finally {
          inFlight.delete(posKey);
        }
      }

      if (tracked.state === "EXIT_TRIGGERED") {
        if (inFlight.has(posKey)) continue;
        inFlight.add(posKey);

        tracked.state = "EXITING";
        log("EXIT", "Executing exit", { positionAddress: posKey });

        try {
          const result: ExitResult = await executeFullExit(
            pos,
            wallet,
            connection,
            CONFIG.dryRun
          );

          if (result.success) {
            tracked.state = "EXITED";
            log("EXIT", "Position exited successfully", {
              positionAddress: posKey,
              claimedFeeX: result.claimedFeeX,
              claimedFeeY: result.claimedFeeY,
              receivedX: result.receivedX,
              receivedY: result.receivedY,
              txCount: result.txSignatures.length,
            });
          } else {
            tracked.state = "MONITORING";
            log("WARN", "Exit failed, reverting to MONITORING", {
              positionAddress: posKey,
              error: result.error,
            });
          }
        } catch (err) {
          tracked.state = "MONITORING";
          logError(`Unexpected error during exit of ${posKey}`, err);
        } finally {
          inFlight.delete(posKey);
        }
      }
    }

    // Check if all positions have been exited
    const remaining = trackedPositions.filter(
      (t) => t.state !== "EXITED"
    );
    if (remaining.length === 0 && trackedPositions.length > 0) {
      log("EXIT", "All positions have been exited. Agent shutting down.");
      handleShutdown();
      return;
    }

    if (trackedPositions.length === 0) {
      log("INFO", "No positions to monitor. Retrying in next cycle.");
    }

    setTimeout(loop, CONFIG.pollIntervalMs);
  };

  // Start first cycle
  setTimeout(loop, 0);
}
