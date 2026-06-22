import { CONFIG } from "./config";
import { connection, wallet, logWalletInfo } from "./wallet";
import {
  fetchAllActivePositions,
  ActivePosition,
  PNLData,
} from "./position-fetcher";
import {
  getCandles15m,
} from "./price-feed";
import { checkExitConditions } from "./indicators";
import { executeFullExit, ExitResult } from "./exit-executor";
import { log, logError } from "./logger";
import { withRpcFallback } from "./rpc-manager";
import {
  notifyAgentStart,
  notifyExitTriggered,
  notifyExitSuccess,
  notifyExitFailed,
  notifyOORRight,
  notifyOORLeft,
} from "./telegram";

const REQUIRED_CANDLES = 60;
const POSITION_REFETCH_INTERVAL = 10;

type PositionState = "MONITORING" | "EXIT_TRIGGERED" | "EXITING" | "EXITED";

interface TrackedPosition {
  position: ActivePosition;
  state: PositionState;
}

export interface PositionSnapshot {
  positionAddress: string;
  poolAddress: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  price: number;
  rsi: number;
  bbUpper: number;
  isInRange: boolean;
  isOORRight: boolean;
  isOORLeft: boolean;
  pnl: PNLData | null;
  state: PositionState;
  createdAt: number;
}

export let lastPositionSnapshots: PositionSnapshot[] = [];

let isShuttingDown = false;
const inFlightSet = new Set<string>();
const oorRightLastNotified = new Map<string, number>();
const oorLeftLastNotified = new Map<string, number>();
const wasOOR = new Set<string>();
const lastIndicatorData = new Map<string, { price: number; rsi: number; bbUpper: number }>();
const positionCreatedAt = new Map<string, number>();

async function handleShutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log("INFO", "Agent stopped by user");
  await new Promise(r => setTimeout(r, 2000));
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
  let initialPositions: ActivePosition[] = [];
  try {
    initialPositions = await withRpcFallback(conn =>
      fetchAllActivePositions(wallet.publicKey, conn)
    );
  } catch (err) {
    logError("Failed to fetch positions on startup", err);
  }

  trackedPositions = initialPositions.map((p) => {
    const key = p.positionPubkey.toBase58();
    if (!positionCreatedAt.has(key)) {
      positionCreatedAt.set(key, Date.now());
    }
    return { position: p, state: "MONITORING" as PositionState };
  });

  notifyAgentStart({
    positionsCount: trackedPositions.length,
    dryRun: CONFIG.dryRun,
    rsiThreshold: CONFIG.rsiThreshold,
    pollIntervalMs: CONFIG.pollIntervalMs,
  });

  log("INFO", "Monitor started", {
    positionsCount: trackedPositions.length,
    dryRun: CONFIG.dryRun,
    rsiPeriod: CONFIG.rsiPeriod,
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

    // Only re-fetch positions every POSITION_REFETCH_INTERVAL cycles
    const shouldRefetch = pollCycle % POSITION_REFETCH_INTERVAL === 1;
    if (shouldRefetch) {
      log("INFO", "Re-fetching position list");
      try {
        const freshPositions = await withRpcFallback(conn =>
          fetchAllActivePositions(wallet.publicKey, conn)
        );

        for (const pos of freshPositions) {
          if (
            !trackedPositions.some(
              (t) =>
                t.position.positionPubkey.toBase58() ===
                pos.positionPubkey.toBase58()
            )
          ) {
            const key = pos.positionPubkey.toBase58();
            if (!positionCreatedAt.has(key)) {
              positionCreatedAt.set(key, Date.now());
            }
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
      } catch (err) {
        logError("Failed to re-fetch positions, using cached data", err);
      }
    }

    // Process each position
    for (const tracked of trackedPositions) {
      if (isShuttingDown) break;

      const pos = tracked.position;
      const posKey = pos.positionPubkey.toBase58();

      if (tracked.state === "EXITED") continue;

      if (tracked.state === "MONITORING") {
        if (inFlightSet.has(posKey)) continue;

        inFlightSet.add(posKey);
        try {
          const candles = await getCandles15m(
            pos.tokenMint,
            REQUIRED_CANDLES
          );

          const currentPrice = candles[candles.length - 1].close;

          const snapshot = checkExitConditions(candles);

          lastIndicatorData.set(posKey, {
            price: currentPrice,
            rsi: snapshot.rsi,
            bbUpper: snapshot.bb.upper,
          });

          log("INFO", `Position ${posKey.slice(0, 8)}...`, {
            rsi: snapshot.rsi.toFixed(2),
            bbUpper: snapshot.bb.upper.toFixed(8),
            bbMiddle: snapshot.bb.middle.toFixed(8),
            bbLower: snapshot.bb.lower.toFixed(8),
            price: snapshot.price.toFixed(8),
            shouldExit: snapshot.shouldExit,
            isOORRight: pos.isOORRight,
            isOORLeft: pos.isOORLeft,
          });

          const hourMs = 60 * 60 * 1000;

          if (pos.isOORRight) {
            log("WARN", "Position is OUT-OF-RANGE RIGHT", {
              positionAddress: posKey,
              price: currentPrice,
            });
            const lastNotified = oorRightLastNotified.get(posKey) ?? 0;
            if (Date.now() - lastNotified > hourMs) {
              notifyOORRight({
                positionAddress: posKey,
                poolAddress: pos.poolAddress.toBase58(),
                rsi: snapshot.rsi,
                bbUpper: snapshot.bb.upper,
                price: currentPrice,
              });
              oorRightLastNotified.set(posKey, Date.now());
            }
          }

          if (pos.isOORLeft) {
            log("WARN", "Position is OUT-OF-RANGE LEFT", {
              positionAddress: posKey,
              price: currentPrice,
            });
            const lastNotified = oorLeftLastNotified.get(posKey) ?? 0;
            if (Date.now() - lastNotified > hourMs) {
              notifyOORLeft({
                positionAddress: posKey,
                poolAddress: pos.poolAddress.toBase58(),
                rsi: snapshot.rsi,
                bbUpper: snapshot.bb.upper,
                price: currentPrice,
              });
              oorLeftLastNotified.set(posKey, Date.now());
            }
          }

          const isOORNow = pos.isOORRight || pos.isOORLeft;
          if (wasOOR.has(posKey) && !isOORNow) {
            oorRightLastNotified.delete(posKey);
            oorLeftLastNotified.delete(posKey);
            wasOOR.delete(posKey);
          }
          if (isOORNow) wasOOR.add(posKey);

          // If RSI is 0, indicators couldn't be computed (not enough data)
          if (snapshot.rsi === 0 && snapshot.bb.upper === 0) {
            log("WARN", `Insufficient data for position ${posKey.slice(0, 8)}...`, {
              candlesCount: candles.length,
              price: snapshot.price.toFixed(8),
            });
            continue;
          }

          if (snapshot.shouldExit) {
            log("EXIT", "EXIT CONDITIONS MET", {
              positionAddress: posKey,
              rsi: snapshot.rsi.toFixed(2),
              price: snapshot.price.toFixed(8),
              bbUpper: snapshot.bb.upper.toFixed(8),
              poolAddress: pos.poolAddress.toBase58(),
            });
            notifyExitTriggered({
              positionAddress: posKey,
              poolAddress: pos.poolAddress.toBase58(),
              rsi: snapshot.rsi,
              price: snapshot.price,
              bbUpper: snapshot.bb.upper,
              trigger: "RSI_BB",
              pnl: pos.pnl,
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
              receivedX: result.receivedX,
              receivedY: result.receivedY,
              txCount: result.txSignatures.length,
            });
            notifyExitSuccess({
              positionAddress: posKey,
              tokenXSymbol: pos.tokenXSymbol,
              tokenYSymbol: pos.tokenYSymbol,
              receivedX: result.receivedX,
              receivedY: result.receivedY,
              txSignatures: result.txSignatures,
              dryRun: result.dryRun,
              pnl: pos.pnl,
              swapResult: result.swapResult,
            });
          } else {
            tracked.state = "MONITORING";
            log("WARN", "Exit failed, reverting to MONITORING", {
              positionAddress: posKey,
              error: result.error,
            });
            notifyExitFailed({
              positionAddress: posKey,
              error: result.error ?? "Unknown error",
            });
          }
        } catch (err) {
          tracked.state = "MONITORING";
          logError(`Unexpected error during exit of ${posKey}`, err);
          notifyExitFailed({
            positionAddress: posKey,
            error: err instanceof Error ? err.message : String(err),
          });
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
      await handleShutdown();
      break;
    }

    if (trackedPositions.length === 0) {
      log("INFO", "No positions to monitor");
    }

    // Rebuild snapshots for /positions command
    lastPositionSnapshots = trackedPositions
      .filter((t) => t.state !== "EXITED")
      .map((t) => {
        const key = t.position.positionPubkey.toBase58();
        const ind = lastIndicatorData.get(key);
        return {
          positionAddress: key,
          poolAddress: t.position.poolAddress.toBase58(),
          tokenXSymbol: t.position.tokenXSymbol,
          tokenYSymbol: t.position.tokenYSymbol,
          price: ind?.price ?? 0,
          rsi: ind?.rsi ?? 0,
          bbUpper: ind?.bbUpper ?? 0,
          isInRange: t.position.isInRange,
          isOORRight: t.position.isOORRight,
          isOORLeft: t.position.isOORLeft,
          pnl: t.position.pnl,
          state: t.state,
          createdAt: positionCreatedAt.get(key) ?? Date.now(),
        };
      });

    await sleep(CONFIG.pollIntervalMs);
  }
}
