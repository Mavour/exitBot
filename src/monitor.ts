import { CONFIG } from "./config";
import { connection, wallet, logWalletInfo } from "./wallet";
import {
  fetchAllActivePositions,
  ActivePosition,
} from "./position-fetcher";
import {
  getCandles15m,
} from "./price-feed";
import { checkExitConditions } from "./indicators";
import { executeFullExit, ExitResult } from "./exit-executor";
import { log, logError } from "./logger";

const REQUIRED_CANDLES = 60;

type PositionState = "MONITORING" | "EXIT_TRIGGERED" | "EXITING" | "EXITED";

interface TrackedPosition {
  position: ActivePosition;
  state: PositionState;
}

let isShuttingDown = false;
const inFlightSet = new Set<string>();

function handleShutdown(): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log("INFO", "Agent stopped by user");
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startMonitor(): Promise<void> {
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  await logWalletInfo();

  let trackedPositions: TrackedPosition[] = [];
  let pollCycle = 0;

  // Fetch & resolve on startup
    const initialPositions = await fetchAllActivePositions(
    wallet.publicKey,
    connection
  );

  trackedPositions = initialPositions.map((p) => ({
    position: p,
    state: "MONITORING" as PositionState,
  }));

  log("INFO", "Monitor started", {
    positionsCount: trackedPositions.length,
    dryRun: CONFIG.dryRun,
    rsiPeriod: CONFIG.rsiPeriod,
    rsiSmoothingLength: CONFIG.rsiSmoothingLength,
    rsiThreshold: CONFIG.rsiThreshold,
    bbPeriod: CONFIG.bbPeriod,
  });

  // Main loop
  while (!isShuttingDown) {
    pollCycle++;
    log("INFO", `Poll cycle ${pollCycle}`, {
      monitored: trackedPositions.filter((t) => t.state !== "EXITED").length,
      inFlight: inFlightSet.size,
    });

    log("INFO", "Re-fetching position list");
    const freshPositions = await fetchAllActivePositions(
      wallet.publicKey,
      connection
    );

    for (const pos of freshPositions) {
      if (
        !trackedPositions.some(
          (t) =>
            t.position.positionPubkey.toBase58() ===
            pos.positionPubkey.toBase58()
        )
      ) {
        trackedPositions.push({
          position: pos,
          state: "MONITORING",
        });
        log("INFO", "New position detected", {
          positionAddress: pos.positionPubkey.toBase58(),
        });
      }
    }

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

    // Process each position
    for (const tracked of trackedPositions) {
      if (isShuttingDown) break;

      const pos = tracked.position;
      const posKey = pos.positionPubkey.toBase58();

      if (tracked.state === "EXITED") continue;

      if (tracked.state === "MONITORING") {
        if (inFlightSet.has(posKey)) continue;

        if (!pos.dexScreenerPairAddress) {
          log("WARN", "No DexScreener pair address, skipping", {
            positionAddress: posKey,
          });
          continue;
        }

        inFlightSet.add(posKey);

        try {
          const candles = await getCandles15m(
            pos.poolAddress.toBase58(),
            REQUIRED_CANDLES
          );

          const snapshot = checkExitConditions(candles);

          // If RSI is 0, indicators couldn't be computed (not enough data)
          if (snapshot.smoothedRsi === 0 && snapshot.bb.upper === 0) {
            log("WARN", `Insufficient data for position ${posKey.slice(0, 8)}...`, {
              candlesCount: candles.length,
              price: snapshot.price.toFixed(8),
            });
            continue;
          }

          log("INFO", `Position ${posKey.slice(0, 8)}...`, {
            smoothedRsi: snapshot.smoothedRsi.toFixed(2),
            bbUpper: snapshot.bb.upper.toFixed(8),
            bbMiddle: snapshot.bb.middle.toFixed(8),
            bbLower: snapshot.bb.lower.toFixed(8),
            price: snapshot.price.toFixed(8),
            shouldExit: snapshot.shouldExit,
          });

          if (snapshot.shouldExit) {
            log("EXIT", "EXIT CONDITIONS MET", {
              positionAddress: posKey,
              smoothedRsi: snapshot.smoothedRsi.toFixed(2),
              price: snapshot.price.toFixed(8),
              bbUpper: snapshot.bb.upper.toFixed(8),
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
          inFlightSet.delete(posKey);
        }
      }

      if (tracked.state === "EXIT_TRIGGERED") {
        if (inFlightSet.has(posKey)) continue;
        inFlightSet.add(posKey);

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
          inFlightSet.delete(posKey);
        }
      }
    }

    // Check if all done
    const remaining = trackedPositions.filter(
      (t) => t.state !== "EXITED"
    );
    if (remaining.length === 0 && trackedPositions.length > 0) {
      log("EXIT", "All positions exited. Agent shutting down.");
      handleShutdown();
      break;
    }

    if (trackedPositions.length === 0) {
      log("INFO", "No positions to monitor");
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}
