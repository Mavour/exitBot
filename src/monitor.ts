import { CONFIG } from "./config";
import { connection, wallet, logWalletInfo } from "./wallet";
import { PublicKey } from "@solana/web3.js";
import {
  fetchAllActivePositions,
  ActivePosition,
} from "./position-fetcher";
import {
  getCandles15m,
} from "./price-feed";
import { checkExitConditions, BollingerBand } from "./indicators";
import { executeFullExit, ExitResult } from "./exit-executor";
import { log, logError } from "./logger";
import { withRpcFallback } from "./rpc-manager";
import {
  notifyAgentStart,
  notifyExitSuccess,
  notifyExitFailed,
  notifyOORRight,
  notifyOORLeft,
  notifyOORUnknown,
  notifyBackInRange,
} from "./telegram";
import { hasExitRecord, saveExitRecord } from "./exit-history";
import {
  createManualCloseSnapshot,
  getManualCloseSnapshots,
  saveActivePositionSnapshots,
  snapshotToManualExitRecord,
  ManualCloseSnapshot,
} from "./manual-close-cache";

const REQUIRED_CANDLES = 60;
const POSITION_REFETCH_INTERVAL = 1;
const HARD_STOP_LOSS_PNL_PERCENT = -15;

type PositionState = "MONITORING" | "EXIT_TRIGGERED" | "EXITING" | "EXITED";
type ExitTriggerType = "HARD_STOP_LOSS" | "RSI_BB" | "TRAILING_PROFIT";
type BBExitBand = "upper" | "middle" | "lower";

interface ExitSignalContext {
  triggerType: ExitTriggerType;
  rsi: number;
  price: number;
  bbExitBand: BBExitBand;
  bbExitPrice: number;
  peakPnlSol?: number;
  peakPnlPercent?: number;
  trailingDropPercent?: number;
}

function safeNotify(fn: () => Promise<void>, label: string): void {
  fn().catch((err) => logError(`${label} notify failed`, err));
}

interface TrackedPosition {
  position: ActivePosition;
  state: PositionState;
  exitTriggerType?: ExitTriggerType;
  exitSignal?: ExitSignalContext;
}

export interface PositionSnapshot {
  poolAddress: string;
  positionAddress: string;
  rsi: number;
  bb: BollingerBand;
  price: number;
  isInRange: boolean;
  isOORRight: boolean;
  isOORLeft: boolean;
}

export let lastPositionSnapshots: PositionSnapshot[] = [];

let isShuttingDown = false;
const inFlightSet = new Set<string>();
const oorRightLastNotified = new Map<string, number>();
const oorLeftLastNotified = new Map<string, number>();
const wasOOR = new Set<string>();
const lastIndicatorData = new Map<string, { price: number; rsi: number; bb: BollingerBand }>();
const positionCreatedAt = new Map<string, number>();
const positionPeakPnl = new Map<string, { pnlSol: number; pnlPercent: number; timestamp: string }>();

async function isPositionClosedOnChain(positionAddress: string): Promise<boolean> {
  const accountInfo = await withRpcFallback(conn =>
    conn.getAccountInfo(new PublicKey(positionAddress), CONFIG.commitment)
  );
  const owner = accountInfo?.owner?.toBase58();
  return !accountInfo || owner === "11111111111111111111111111111111";
}

function saveManualCloseRecord(snapshot: ManualCloseSnapshot): void {
  if (hasExitRecord(snapshot.positionAddress)) {
    log("INFO", "Manual close already present in exit history, skipping duplicate", {
      positionAddress: snapshot.positionAddress,
    });
    return;
  }

  saveExitRecord(snapshotToManualExitRecord(snapshot));
}

async function recordClosedSnapshots(activePositions: ActivePosition[]): Promise<void> {
  const activeKeys = new Set(activePositions.map((p) => p.positionPubkey.toBase58()));
  for (const snapshot of getManualCloseSnapshots()) {
    if (activeKeys.has(snapshot.positionAddress) || hasExitRecord(snapshot.positionAddress)) {
      continue;
    }

    try {
      const isClosed = await isPositionClosedOnChain(snapshot.positionAddress);
      if (!isClosed) {
        log("WARN", "Snapshot missing from Meteora API but position account still exists", {
          positionAddress: snapshot.positionAddress,
        });
        continue;
      }

      log("WARN", "Closed position detected from saved snapshot", {
        positionAddress: snapshot.positionAddress,
      });
      saveManualCloseRecord(snapshot);
    } catch (err) {
      logError(`Failed to confirm closed snapshot ${snapshot.positionAddress}`, err);
    }
  }
}

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

function updatePeakPnl(position: ActivePosition): void {
  if (!position.pnl) return;

  const key = position.positionPubkey.toBase58();
  const current = positionPeakPnl.get(key);
  if (!current || position.pnl.pnlPercent > current.pnlPercent) {
    const peak = {
      pnlSol: position.pnl.pnlSol,
      pnlPercent: position.pnl.pnlPercent,
      timestamp: new Date().toISOString(),
    };
    positionPeakPnl.set(key, peak);
    log("INFO", "Position PNL peak updated", {
      positionAddress: key,
      peakPnlSol: peak.pnlSol,
      peakPnlPercent: peak.pnlPercent,
      peakPnlAt: peak.timestamp,
    });
  }
}

function restorePeakPnlFromSnapshots(): void {
  for (const snapshot of getManualCloseSnapshots()) {
    if (
      snapshot.peakPnlSol === undefined ||
      snapshot.peakPnlPercent === undefined ||
      !Number.isFinite(snapshot.peakPnlSol) ||
      !Number.isFinite(snapshot.peakPnlPercent)
    ) {
      continue;
    }

    const current = positionPeakPnl.get(snapshot.positionAddress);
    if (!current || snapshot.peakPnlPercent > current.pnlPercent) {
      positionPeakPnl.set(snapshot.positionAddress, {
        pnlSol: snapshot.peakPnlSol,
        pnlPercent: snapshot.peakPnlPercent,
        timestamp: snapshot.peakPnlAt ?? new Date().toISOString(),
      });
    }
  }
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
  saveActivePositionSnapshots(initialPositions);
  restorePeakPnlFromSnapshots();
  await recordClosedSnapshots(initialPositions);

  trackedPositions = initialPositions.map((p) => {
    const key = p.positionPubkey.toBase58();
    if (!positionCreatedAt.has(key)) {
      positionCreatedAt.set(key, Date.now());
    }
    updatePeakPnl(p);
    return { position: p, state: "MONITORING" as PositionState };
  });

  safeNotify(
    () =>
      notifyAgentStart({
        positionsCount: trackedPositions.length,
        dryRun: CONFIG.dryRun,
        rsiThreshold: CONFIG.rsiThreshold,
        pollIntervalMs: CONFIG.pollIntervalMs,
        exitCooldownMs: CONFIG.exitCooldownMs,
        indicatorExitMinPnlPercent: CONFIG.indicatorExitMinPnlPercent,
        trailingArmPercent: CONFIG.trailingArmPercent,
        trailingDropPercent: CONFIG.trailingDropPercent,
      }),
    "agent start"
  );

  log("INFO", "Monitor started", {
    positionsCount: trackedPositions.length,
    dryRun: CONFIG.dryRun,
    rsiPeriod: CONFIG.rsiPeriod,
    rsiThreshold: CONFIG.rsiThreshold,
    bbPeriod: CONFIG.bbPeriod,
    exitCooldownMs: CONFIG.exitCooldownMs,
    indicatorExitMinPnlPercent: CONFIG.indicatorExitMinPnlPercent,
    trailingArmPercent: CONFIG.trailingArmPercent,
    trailingDropPercent: CONFIG.trailingDropPercent,
  });

  // Main loop
  while (!isShuttingDown) {
    pollCycle++;
    log("INFO", `Poll cycle ${pollCycle}`, {
      monitored: trackedPositions.filter((t) => t.state !== "EXITED").length,
      inFlight: inFlightSet.size,
    });

    // Only re-fetch positions every POSITION_REFETCH_INTERVAL cycles
    const shouldRefetch = pollCycle % POSITION_REFETCH_INTERVAL === 0;
    if (shouldRefetch) {
      log("INFO", "Re-fetching position list");
      try {
        const freshPositions = await withRpcFallback(conn =>
          fetchAllActivePositions(wallet.publicKey, conn)
        );
        saveActivePositionSnapshots(freshPositions);
        await recordClosedSnapshots(freshPositions);

        for (const pos of freshPositions) {
          updatePeakPnl(pos);
          const existing = trackedPositions.find(
            (t) =>
              t.position.positionPubkey.toBase58() ===
              pos.positionPubkey.toBase58()
          );
          if (existing) {
            if (existing.state === "MONITORING") {
              existing.position = pos;
            }
            continue;
          }
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

        const freshKeys = new Set(
          freshPositions.map((p) => p.positionPubkey.toBase58())
        );
        const nextTrackedPositions: TrackedPosition[] = [];
        for (const t of trackedPositions) {
          if (t.state === "EXITED") continue;
          const key = t.position.positionPubkey.toBase58();
          if (!freshKeys.has(key) && t.state === "MONITORING") {
            try {
              const isClosed = await isPositionClosedOnChain(key);
              if (!isClosed) {
                log("WARN", "Position missing from Meteora API but still exists on-chain, keeping tracked", {
                  positionAddress: key,
                });
                nextTrackedPositions.push(t);
                continue;
              }

              log("WARN", "Position no longer active on-chain, removing from tracking", {
                positionAddress: key,
              });
            } catch (saveErr) {
              logError("manual close detection failed (non-fatal)", saveErr);
              nextTrackedPositions.push(t);
            }
            continue;
          }
          nextTrackedPositions.push(t);
        }
        trackedPositions = nextTrackedPositions;
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
          let closedOnChain = false;
          try {
            closedOnChain = await isPositionClosedOnChain(posKey);
          } catch (closedCheckErr) {
            logError(`Failed to check on-chain close status for ${posKey}`, closedCheckErr);
          }

          if (closedOnChain) {
            log("WARN", "Position account closed on-chain, recording manual close", {
              positionAddress: posKey,
            });
            const snapshot =
              getManualCloseSnapshots().find((s) => s.positionAddress === posKey) ??
              createManualCloseSnapshot(pos);
            saveManualCloseRecord(snapshot);
            tracked.state = "EXITED";
            continue;
          }

          if (pos.pnl !== null && pos.pnl.pnlPercent <= HARD_STOP_LOSS_PNL_PERCENT) {
            const peakPnl = positionPeakPnl.get(posKey);
            log("EXIT", "EXIT CONDITIONS MET", {
              positionAddress: posKey,
              triggerType: "HARD_STOP_LOSS",
              poolAddress: pos.poolAddress.toBase58(),
              currentPnlSol: pos.pnl.pnlSol,
              currentPnlPercent: pos.pnl.pnlPercent,
              peakPnlSol: peakPnl?.pnlSol ?? null,
              peakPnlPercent: peakPnl?.pnlPercent ?? null,
              peakPnlAt: peakPnl?.timestamp ?? null,
              hardStopLossPnlPercent: HARD_STOP_LOSS_PNL_PERCENT,
              exitBypassesCooldown: true,
            });
            tracked.exitTriggerType = "HARD_STOP_LOSS";
            tracked.exitSignal = undefined;
            tracked.state = "EXIT_TRIGGERED";
          }

          if (tracked.state === "MONITORING") {
          const candles = await getCandles15m(
            pos.tokenMint,
            REQUIRED_CANDLES
          );

          const currentPrice = candles[candles.length - 1].close;

          const snapshot = checkExitConditions(candles);

          lastIndicatorData.set(posKey, {
            price: currentPrice,
            rsi: snapshot.rsi,
            bb: snapshot.bb,
          });

          const peakPnl = positionPeakPnl.get(posKey);

          log("INFO", `Position ${posKey.slice(0, 8)}...`, {
            rsi: snapshot.rsi.toFixed(2),
            bbUpper: snapshot.bb.upper.toFixed(8),
            bbMiddle: snapshot.bb.middle.toFixed(8),
            bbLower: snapshot.bb.lower.toFixed(8),
            bbExitBand: CONFIG.bbExitBand,
            bbExitPrice: snapshot.bb[CONFIG.bbExitBand].toFixed(8),
            price: snapshot.price.toFixed(8),
            shouldExit: snapshot.shouldExit,
            isOORRight: pos.isOORRight,
            isOORLeft: pos.isOORLeft,
            currentPnlSol: pos.pnl?.pnlSol ?? null,
            currentPnlPercent: pos.pnl?.pnlPercent ?? null,
            pnlSource: pos.pnl?.source ?? null,
            peakPnlSol: peakPnl?.pnlSol ?? null,
            peakPnlPercent: peakPnl?.pnlPercent ?? null,
            peakPnlAt: peakPnl?.timestamp ?? null,
          });

          const hourMs = 60 * 60 * 1000;

          if (pos.isOORRight) {
            log("WARN", "Position is OUT-OF-RANGE RIGHT", {
              positionAddress: posKey,
              price: currentPrice,
            });
            const lastNotified = oorRightLastNotified.get(posKey) ?? 0;
            if (Date.now() - lastNotified > hourMs) {
              safeNotify(
                () =>
                  notifyOORRight({
                    positionAddress: posKey,
                    poolAddress: pos.poolAddress.toBase58(),
                    rsi: snapshot.rsi,
                    bbUpper: snapshot.bb.upper,
                    price: currentPrice,
                  }),
                "OOR right"
              );
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
              safeNotify(
                () =>
                  notifyOORLeft({
                    positionAddress: posKey,
                    poolAddress: pos.poolAddress.toBase58(),
                    rsi: snapshot.rsi,
                    bbUpper: snapshot.bb.upper,
                    price: currentPrice,
                  }),
                "OOR left"
              );
              oorLeftLastNotified.set(posKey, Date.now());
            }
          }

          if (!pos.isInRange && !pos.isOORRight && !pos.isOORLeft) {
            log("WARN", "Position is OOR but direction unknown", {
              positionAddress: posKey,
              price: currentPrice,
            });
            safeNotify(
              () =>
                notifyOORUnknown({
                  positionAddress: posKey,
                  poolAddress: pos.poolAddress.toBase58(),
                  rsi: snapshot.rsi,
                  bbUpper: snapshot.bb.upper,
                  price: currentPrice,
                }),
              "OOR unknown"
            );
          }

          const isOORNow = pos.isOORRight || pos.isOORLeft;
          const isInRangeNow = pos.isInRange && !isOORNow;
          const wasOORBefore = wasOOR.has(posKey);

          if (wasOORBefore && isInRangeNow) {
            log("INFO", "Position recovered to IN-RANGE", {
              positionAddress: posKey,
              price: currentPrice,
            });
            safeNotify(
              () =>
                notifyBackInRange({
                  positionAddress: posKey,
                  poolAddress: pos.poolAddress.toBase58(),
                  rsi: snapshot.rsi,
                  bbUpper: snapshot.bb.upper,
                  price: currentPrice,
                }),
              "back in range"
            );
          }

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

          const createdAt = positionCreatedAt.get(posKey) ?? Date.now();
          const positionAgeMs = Date.now() - createdAt;
          const cooldownPassed = positionAgeMs >= CONFIG.exitCooldownMs;
          const trailingArmed =
            peakPnl !== undefined &&
            peakPnl.pnlPercent >= CONFIG.trailingArmPercent;
          const trailingDropPercent =
            trailingArmed && pos.pnl
              ? peakPnl.pnlPercent - pos.pnl.pnlPercent
              : 0;
          const shouldTrailingExit =
            trailingArmed &&
            pos.pnl !== null &&
            trailingDropPercent >= CONFIG.trailingDropPercent;
          const shouldHardStopLossExit =
            pos.pnl !== null &&
            pos.pnl.pnlPercent <= HARD_STOP_LOSS_PNL_PERCENT;
          const indicatorExitPnlOk =
            pos.pnl !== null &&
            pos.pnl.pnlPercent > CONFIG.indicatorExitMinPnlPercent;
          const shouldIndicatorExit = snapshot.shouldExit && indicatorExitPnlOk;
          const exitTrigger = shouldHardStopLossExit
            ? "HARD_STOP_LOSS"
            : shouldTrailingExit
              ? "TRAILING_PROFIT"
              : shouldIndicatorExit
                ? "RSI_BB"
                : null;
          const exitBypassesCooldown = exitTrigger === "HARD_STOP_LOSS";

          if (snapshot.shouldExit && !indicatorExitPnlOk) {
            log("INFO", "Indicator exit signal ignored below minimum PNL", {
              positionAddress: posKey,
              rsi: snapshot.rsi.toFixed(2),
              price: snapshot.price.toFixed(8),
              bbExitBand: CONFIG.bbExitBand,
              bbExitPrice: snapshot.bb[CONFIG.bbExitBand].toFixed(8),
              currentPnlSol: pos.pnl?.pnlSol ?? null,
              currentPnlPercent: pos.pnl?.pnlPercent ?? null,
              indicatorExitMinPnlPercent: CONFIG.indicatorExitMinPnlPercent,
            });
          }

          if (exitTrigger && !exitBypassesCooldown && !cooldownPassed) {
            log("INFO", "Exit signal ignored during cooldown", {
              positionAddress: posKey,
              triggerType: exitTrigger,
              ageSeconds: Math.floor(positionAgeMs / 1000),
              cooldownSeconds: Math.floor(CONFIG.exitCooldownMs / 1000),
              rsi: snapshot.rsi.toFixed(2),
              price: snapshot.price.toFixed(8),
              bbExitBand: CONFIG.bbExitBand,
              bbExitPrice: snapshot.bb[CONFIG.bbExitBand].toFixed(8),
              currentPnlSol: pos.pnl?.pnlSol ?? null,
              currentPnlPercent: pos.pnl?.pnlPercent ?? null,
              peakPnlSol: peakPnl?.pnlSol ?? null,
              peakPnlPercent: peakPnl?.pnlPercent ?? null,
              peakPnlAt: peakPnl?.timestamp ?? null,
              trailingArmed,
              trailingDropPercent,
              trailingArmPercent: CONFIG.trailingArmPercent,
              trailingDropThreshold: CONFIG.trailingDropPercent,
              indicatorExitMinPnlPercent: CONFIG.indicatorExitMinPnlPercent,
              hardStopLossPnlPercent: HARD_STOP_LOSS_PNL_PERCENT,
            });
            continue;
          }

          if (exitTrigger) {
            log("EXIT", "EXIT CONDITIONS MET", {
              positionAddress: posKey,
              triggerType: exitTrigger,
              rsi: snapshot.rsi.toFixed(2),
              price: snapshot.price.toFixed(8),
              bbUpper: snapshot.bb.upper.toFixed(8),
              bbExitBand: CONFIG.bbExitBand,
              bbExitPrice: snapshot.bb[CONFIG.bbExitBand].toFixed(8),
              poolAddress: pos.poolAddress.toBase58(),
              currentPnlSol: pos.pnl?.pnlSol ?? null,
              currentPnlPercent: pos.pnl?.pnlPercent ?? null,
              peakPnlSol: peakPnl?.pnlSol ?? null,
              peakPnlPercent: peakPnl?.pnlPercent ?? null,
              peakPnlAt: peakPnl?.timestamp ?? null,
              trailingArmed,
              trailingDropPercent,
              trailingArmPercent: CONFIG.trailingArmPercent,
              trailingDropThreshold: CONFIG.trailingDropPercent,
              indicatorExitMinPnlPercent: CONFIG.indicatorExitMinPnlPercent,
              hardStopLossPnlPercent: HARD_STOP_LOSS_PNL_PERCENT,
              exitBypassesCooldown,
            });
            tracked.exitTriggerType = exitTrigger;
            tracked.exitSignal = {
              triggerType: exitTrigger,
              rsi: snapshot.rsi,
              price: snapshot.price,
              bbExitBand: CONFIG.bbExitBand,
              bbExitPrice: snapshot.bb[CONFIG.bbExitBand],
              peakPnlSol: peakPnl?.pnlSol,
              peakPnlPercent: peakPnl?.pnlPercent,
              trailingDropPercent,
            };
            tracked.state = "EXIT_TRIGGERED";
          }
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
        const peakPnl = positionPeakPnl.get(posKey);
        const exitTriggerType = tracked.exitTriggerType ?? "RSI_BB";
        const exitSignal = tracked.exitSignal;
        log("EXIT", "Executing exit", {
          positionAddress: posKey,
          triggerType: exitTriggerType,
          currentPnlSol: pos.pnl?.pnlSol ?? null,
          currentPnlPercent: pos.pnl?.pnlPercent ?? null,
          peakPnlSol: peakPnl?.pnlSol ?? null,
          peakPnlPercent: peakPnl?.pnlPercent ?? null,
          peakPnlAt: peakPnl?.timestamp ?? null,
        });

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
              triggerType: exitTriggerType,
              swapSuccess: result.swapResult?.success ?? null,
              swapReason: result.swapError ?? null,
              peakPnlSol: peakPnl?.pnlSol ?? null,
              peakPnlPercent: peakPnl?.pnlPercent ?? null,
              peakPnlAt: peakPnl?.timestamp ?? null,
            });
            safeNotify(
              () =>
                notifyExitSuccess({
                  positionAddress: posKey,
                  tokenXSymbol: pos.tokenXSymbol,
                  tokenYSymbol: pos.tokenYSymbol,
                  receivedX: result.receivedX,
                  receivedY: result.receivedY,
                  txSignatures: result.txSignatures,
                  dryRun: result.dryRun,
                  pnl: pos.pnl,
                  trigger: exitTriggerType,
                  rsi: exitSignal?.rsi,
                  price: exitSignal?.price,
                  bbExitBand: exitSignal?.bbExitBand,
                  bbExitPrice: exitSignal?.bbExitPrice,
                  peakPnlSol: exitSignal?.peakPnlSol,
                  peakPnlPercent: exitSignal?.peakPnlPercent,
                  trailingDropPercent: exitSignal?.trailingDropPercent,
                  swapResult: result.swapResult,
                  swapError: result.swapError,
                }),
              "exit success"
            );

            // ALWAYS save exit record when liquidity was removed on-chain.
            // Record even if swap failed/incomplete — the exit itself succeeded.
            if (pos.pnl) {
              try {
                saveExitRecord({
                  timestamp: new Date().toISOString(),
                  exitSource: "BOT",
                  triggerType: exitTriggerType,
                  positionAddress: posKey,
                  poolAddress: pos.poolAddress.toBase58(),
                  tokenXSymbol: pos.tokenXSymbol,
                  tokenYSymbol: pos.tokenYSymbol,
                  receivedX: result.receivedX,
                  receivedY: result.receivedY,
                  pnlPercent: pos.pnl.pnlPercent,
                  pnlSol: pos.pnl.pnlSol,
                  peakPnlSol: peakPnl?.pnlSol,
                  peakPnlPercent: peakPnl?.pnlPercent,
                  peakPnlAt: peakPnl?.timestamp,
                  totalFeeEarnedSol: pos.pnl.totalFeeEarnedSol,
                  depositValueSol: pos.pnl.depositValueSol,
                  dryRun: result.dryRun,
                  swapSuccess: result.swapResult?.success ?? null,
                  swapReason: result.swapError ?? null,
                });
              } catch (saveErr) {
                logError("saveExitRecord failed (non-fatal)", saveErr);
              }
            }
          } else {
            tracked.state = "MONITORING";
            tracked.exitTriggerType = undefined;
            tracked.exitSignal = undefined;
            log("WARN", "Exit failed, reverting to MONITORING", {
              positionAddress: posKey,
              triggerType: exitTriggerType,
              error: result.error,
              currentPnlSol: pos.pnl?.pnlSol ?? null,
              currentPnlPercent: pos.pnl?.pnlPercent ?? null,
              peakPnlSol: peakPnl?.pnlSol ?? null,
              peakPnlPercent: peakPnl?.pnlPercent ?? null,
              peakPnlAt: peakPnl?.timestamp ?? null,
            });
            safeNotify(
              () =>
                notifyExitFailed({
                  positionAddress: posKey,
                  error: result.error ?? "Unknown error",
                }),
              "exit failed"
            );
          }
        } catch (err) {
          tracked.state = "MONITORING";
          tracked.exitTriggerType = undefined;
          tracked.exitSignal = undefined;
          logError(`Unexpected error during exit of ${posKey}`, err);
          safeNotify(
            () =>
              notifyExitFailed({
                positionAddress: posKey,
                error: err instanceof Error ? err.message : String(err),
              }),
            "exit failed (exception)"
          );
        } finally {
          if (tracked.state === "EXITED") {
            positionPeakPnl.delete(posKey);
          }
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
          poolAddress: t.position.poolAddress.toBase58(),
          positionAddress: key,
          rsi: ind?.rsi ?? 0,
          bb: ind?.bb ?? { upper: 0, middle: 0, lower: 0 },
          price: ind?.price ?? 0,
          isInRange: t.position.isInRange,
          isOORRight: t.position.isOORRight,
          isOORLeft: t.position.isOORLeft,
        };
      });

    await sleep(CONFIG.pollIntervalMs);
  }
}
