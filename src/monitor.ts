import { CONFIG } from "./config";
import { connection, wallet, logWalletInfo } from "./wallet";
import { PublicKey } from "@solana/web3.js";
import {
  fetchAllActivePositions,
  ActivePosition,
} from "./position-fetcher";
import {
  getCandles,
} from "./price-feed";
import { checkExitConditions, BollingerBand } from "./indicators";
import { executeFullExit, ExitResult } from "./exit-executor";
import { log, logError } from "./logger";
import { withRpcFallback } from "./rpc-manager";
import {
  setTrackedPositions,
  getTrackedPositions,
  TrackedPosition,
  PositionState,
} from "./tracked-state";
import {
  notifyAgentStart,
  notifyExitSuccess,
  notifyExitStarted,
  notifyExitFailed,
  notifyPositionClosedExternally,
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
const IDLE_REFETCH_INTERVAL_CYCLES = 3; // ~30s with pollIntervalMs default 10000ms

function safeNotify(fn: () => Promise<void>, label: string): void {
  fn().catch((err) => logError(`${label} notify failed`, err));
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
let lastMonitorMode: "idle" | "active" | null = null;
const inFlightSet = new Set<string>();
const oorRightLastNotified = new Map<string, number>();
const oorLeftLastNotified = new Map<string, number>();
const wasOOR = new Set<string>();
const lastIndicatorData = new Map<string, { price: number; rsi: number; bb: BollingerBand }>();
const positionCreatedAt = new Map<string, number>();
const positionPeakPnl = new Map<string, { pnlSol: number; pnlPercent: number; timestamp: string }>();
const lastDepositValueSol = new Map<string, number>();
const lastWithdrawalValueSol = new Map<string, number>();
const lastDepositChangeMs = new Map<string, number>();

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

function handleRangeNotifications(pos: ActivePosition, posKey: string): void {
  const indicator = lastIndicatorData.get(posKey);
  const price = indicator?.price;
  const hourMs = 60 * 60 * 1000;

  if (pos.isOORRight) {
    log("WARN", "Position is OUT-OF-RANGE RIGHT", {
      positionAddress: posKey,
      price: price ?? null,
    });
    const lastNotified = oorRightLastNotified.get(posKey) ?? 0;
    if (Date.now() - lastNotified > hourMs) {
      safeNotify(
        () =>
          notifyOORRight({
            positionAddress: posKey,
            tokenXSymbol: pos.tokenXSymbol,
            tokenYSymbol: pos.tokenYSymbol,
            activeBinId: pos.activeBinId,
            fromBinId: pos.binRange.fromBinId,
            toBinId: pos.binRange.toBinId,
            rsi: indicator?.rsi,
            bbUpper: indicator?.bb.upper,
            price,
          }),
        "OOR right"
      );
      oorRightLastNotified.set(posKey, Date.now());
    }
  }

  if (pos.isOORLeft) {
    log("WARN", "Position is OUT-OF-RANGE LEFT", {
      positionAddress: posKey,
      price: price ?? null,
    });
    const lastNotified = oorLeftLastNotified.get(posKey) ?? 0;
    if (Date.now() - lastNotified > hourMs) {
      safeNotify(
        () =>
          notifyOORLeft({
            positionAddress: posKey,
            tokenXSymbol: pos.tokenXSymbol,
            tokenYSymbol: pos.tokenYSymbol,
            activeBinId: pos.activeBinId,
            fromBinId: pos.binRange.fromBinId,
            toBinId: pos.binRange.toBinId,
            rsi: indicator?.rsi,
            bbUpper: indicator?.bb.upper,
            price,
          }),
        "OOR left"
      );
      oorLeftLastNotified.set(posKey, Date.now());
    }
  }

  if (!pos.isInRange && !pos.isOORRight && !pos.isOORLeft) {
    log("WARN", "Position is OOR but direction unknown", {
      positionAddress: posKey,
      price: price ?? null,
    });
    safeNotify(
      () =>
        notifyOORUnknown({
          positionAddress: posKey,
          tokenXSymbol: pos.tokenXSymbol,
          tokenYSymbol: pos.tokenYSymbol,
          activeBinId: pos.activeBinId,
          fromBinId: pos.binRange.fromBinId,
          toBinId: pos.binRange.toBinId,
          rsi: indicator?.rsi,
          bbUpper: indicator?.bb.upper,
          price,
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
      price: price ?? null,
    });
    safeNotify(
      () =>
        notifyBackInRange({
          positionAddress: posKey,
          tokenXSymbol: pos.tokenXSymbol,
          tokenYSymbol: pos.tokenYSymbol,
          activeBinId: pos.activeBinId,
          fromBinId: pos.binRange.fromBinId,
          toBinId: pos.binRange.toBinId,
          rsi: indicator?.rsi,
          bbUpper: indicator?.bb.upper,
          price,
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
}

export async function startMonitor(): Promise<void> {
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  await logWalletInfo();

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

  setTrackedPositions(initialPositions.map((p) => {
    const key = p.positionPubkey.toBase58();
    if (p.openedAtMs !== undefined) {
      positionCreatedAt.set(key, p.openedAtMs);
    } else if (!positionCreatedAt.has(key)) {
      positionCreatedAt.set(key, p.openedAtMs ?? Date.now());
    }
    if (p.openedAtMs !== undefined && Date.now() - p.openedAtMs < 60_000) {
      lastDepositChangeMs.set(key, Date.now());
      log("INFO", "New position detected; HSL grace period started", {
        positionAddress: key,
        openedAtMs: p.openedAtMs,
        ageMs: Date.now() - p.openedAtMs,
      });
    }
    updatePeakPnl(p);
    return { position: p, state: "MONITORING" as PositionState };
  }));

  safeNotify(
    () =>
      notifyAgentStart({
        positionsCount: getTrackedPositions().length,
        dryRun: CONFIG.dryRun,
        rsiThreshold: CONFIG.rsiThreshold,
        pollIntervalMs: CONFIG.pollIntervalMs,
        exitCooldownMs: CONFIG.exitCooldownMs,
        indicatorExitMinPnlPercent: CONFIG.indicatorExitMinPnlPercent,
        trailingArmPercent: CONFIG.trailingArmPercent,
        trailingDropPercent: CONFIG.trailingDropPercent,
        hardStopLossEnabled: CONFIG.hardStopLossEnabled,
        hardStopLossPnlPercent: CONFIG.hardStopLossPnlPercent,
        macdEnabled: CONFIG.macdEnabled,
        macdFastPeriod: CONFIG.macdFastPeriod,
        macdSlowPeriod: CONFIG.macdSlowPeriod,
        macdSignalPeriod: CONFIG.macdSignalPeriod,
      }),
    "agent start"
  );

  log("INFO", "Monitor started", {
    positionsCount: getTrackedPositions().length,
    dryRun: CONFIG.dryRun,
    rsiPeriod: CONFIG.rsiPeriod,
    rsiThreshold: CONFIG.rsiThreshold,
    bbPeriod: CONFIG.bbPeriod,
    exitCooldownMs: CONFIG.exitCooldownMs,
    indicatorExitMinPnlPercent: CONFIG.indicatorExitMinPnlPercent,
    trailingArmPercent: CONFIG.trailingArmPercent,
    trailingDropPercent: CONFIG.trailingDropPercent,
    hardStopLossEnabled: CONFIG.hardStopLossEnabled,
    hardStopLossPnlPercent: CONFIG.hardStopLossPnlPercent,
    macdEnabled: CONFIG.macdEnabled,
    macdFastPeriod: CONFIG.macdFastPeriod,
    macdSlowPeriod: CONFIG.macdSlowPeriod,
    macdSignalPeriod: CONFIG.macdSignalPeriod,
  });

  // Main loop
  while (!isShuttingDown) {
    pollCycle++;
    log("INFO", `Poll cycle ${pollCycle}`, {
      monitored: getTrackedPositions().filter((t) => t.state !== "EXITED").length,
      inFlight: inFlightSet.size,
    });

    // Refresh Meteora position/PNL data every poll while positions are active;
    // throttle to every IDLE_REFETCH_INTERVAL_CYCLES when there are no active positions.
    const hasActivePositions = getTrackedPositions().some(
      (t) => t.state !== "EXITED"
    );
    const monitorMode: "idle" | "active" = hasActivePositions
      ? "active"
      : "idle";
    if (lastMonitorMode !== monitorMode) {
      log("INFO", "Position monitoring mode changed", {
        from: lastMonitorMode ?? "idle",
        to: monitorMode,
      });
      lastMonitorMode = monitorMode;
    }
    const shouldRefetch = hasActivePositions
      ? true // full-speed every cycle when positions are active — do not slow this down
      : pollCycle % IDLE_REFETCH_INTERVAL_CYCLES === 0; // throttle only when idle
    if (shouldRefetch) {
      log("INFO", "Re-fetching position list");
      try {
        const freshPositions = await withRpcFallback(conn =>
          fetchAllActivePositions(wallet.publicKey, conn)
        );
        saveActivePositionSnapshots(freshPositions);
        await recordClosedSnapshots(freshPositions);

        for (const pos of freshPositions) {
          const key = pos.positionPubkey.toBase58();
          if (pos.openedAtMs !== undefined) {
            positionCreatedAt.set(key, pos.openedAtMs);
          } else if (!positionCreatedAt.has(key)) {
            positionCreatedAt.set(key, Date.now());
          }

          updatePeakPnl(pos);
          const existing = getTrackedPositions().find(
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
          getTrackedPositions().push({
            position: pos,
            state: "MONITORING",
          });
          log("INFO", "New position detected", {
            positionAddress: pos.positionPubkey.toBase58(),
          });
          lastDepositChangeMs.set(key, Date.now());
          log("INFO", "New position detected; HSL grace period started", {
            positionAddress: pos.positionPubkey.toBase58(),
          });
        }

        const freshKeys = new Set(
          freshPositions.map((p) => p.positionPubkey.toBase58())
        );
        const nextTrackedPositions: TrackedPosition[] = [];
        for (const t of getTrackedPositions()) {
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
        setTrackedPositions(nextTrackedPositions);
      } catch (err) {
        logError("Failed to re-fetch positions, using cached data", err);
      }
    }

    // Process each position
    for (const tracked of getTrackedPositions()) {
      if (isShuttingDown) break;

      const pos = tracked.position;
      const posKey = pos.positionPubkey.toBase58();

      if (tracked.state === "EXITED") continue;

      if (tracked.state === "MONITORING") {
        if (inFlightSet.has(posKey)) continue;

        inFlightSet.add(posKey);
        try {
          if (tracked.state === "MONITORING") {
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

          handleRangeNotifications(pos, posKey);

          const { candles, source } = await getCandles(
            pos.tokenMint,
            REQUIRED_CANDLES,
            pos.poolAddress.toBase58()
          );

          const currentPrice = candles[candles.length - 1].close;

          const snapshot = checkExitConditions(candles, source);

          lastIndicatorData.set(posKey, {
            price: currentPrice,
            rsi: snapshot.rsi,
            bb: snapshot.bb,
          });

          const peakPnl = positionPeakPnl.get(posKey);
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
          const createdAt = positionCreatedAt.get(posKey) ?? pos.openedAtMs ?? Date.now();
          const positionAgeMs = Date.now() - createdAt;
          const cooldownPassed = positionAgeMs >= CONFIG.exitCooldownMs;
          const ageSource = pos.openedAtMs ? "meteora_created_at" : "agent_first_seen";

          const prevDepositValueSol = lastDepositValueSol.get(posKey);
          if (pos.pnl?.depositValueSol && prevDepositValueSol && pos.pnl.depositValueSol > prevDepositValueSol * 1.05) {
            lastDepositChangeMs.set(posKey, Date.now());
            log("INFO", "Deposit increased (add liq); HSL grace period started", {
              positionAddress: posKey.slice(0, 8),
              previousDeposit: prevDepositValueSol,
              currentDeposit: pos.pnl.depositValueSol,
            });
          }
          if (pos.pnl?.depositValueSol) lastDepositValueSol.set(posKey, pos.pnl.depositValueSol);

          const prevWithdrawalValueSol = lastWithdrawalValueSol.get(posKey);
          if (
            pos.pnl?.withdrawalValueSol !== undefined &&
            prevWithdrawalValueSol !== undefined &&
            pos.pnl.withdrawalValueSol > prevWithdrawalValueSol
          ) {
            lastDepositChangeMs.set(posKey, Date.now());
            log("INFO", "Withdrawal detected; HSL grace period started", {
              positionAddress: posKey,
              previousWithdrawal: prevWithdrawalValueSol,
              currentWithdrawal: pos.pnl.withdrawalValueSol,
            });
          }
          lastWithdrawalValueSol.set(posKey, pos.pnl?.withdrawalValueSol ?? prevWithdrawalValueSol ?? 0);

          const inDepositGrace = lastDepositChangeMs.has(posKey) && (Date.now() - lastDepositChangeMs.get(posKey)!) < 60_000;

          const shouldHardStopLossExit =
            CONFIG.hardStopLossEnabled &&
            pos.pnl !== null &&
            pos.pnl.pnlPercent <= CONFIG.hardStopLossPnlPercent &&
            !inDepositGrace;
          const indicatorExitPnlOk =
            pos.pnl !== null &&
            pos.pnl.pnlPercent > CONFIG.indicatorExitMinPnlPercent;
          const shouldIndicatorExit = snapshot.shouldExit && indicatorExitPnlOk;
          const shouldMacdExit =
            CONFIG.macdEnabled &&
            snapshot.shouldExitMacd &&
            indicatorExitPnlOk;
          const exitTrigger = shouldHardStopLossExit
            ? "HARD_STOP_LOSS"
            : shouldTrailingExit
              ? "TRAILING_PROFIT"
              : shouldIndicatorExit
                ? "RSI_BB"
                : shouldMacdExit
                  ? "RSI_MACD"
                  : null;
          const exitBypassesCooldown = exitTrigger === "HARD_STOP_LOSS";

          log("INFO", `Position ${posKey.slice(0, 8)}...`, {
            rsi: snapshot.rsi.toFixed(2),
            bbUpper: snapshot.bb.upper.toFixed(8),
            bbMiddle: snapshot.bb.middle.toFixed(8),
            bbLower: snapshot.bb.lower.toFixed(8),
            bbExitBand: CONFIG.bbExitBand,
            bbExitPrice: snapshot.bb[CONFIG.bbExitBand].toFixed(8),
            macdLine: snapshot.macd.macdLine.toFixed(8),
            macdSignal: snapshot.macd.signalLine.toFixed(8),
            macdHistogram: snapshot.macd.histogram.toFixed(8),
            macdGreen: snapshot.shouldExitMacd,
            price: snapshot.price.toFixed(8),
            shouldExit: snapshot.shouldExit,
            hardStopLossExit: shouldHardStopLossExit,
            inDepositGrace,
            indicatorPnlOk: indicatorExitPnlOk,
            macdRuleEnabled: CONFIG.macdEnabled,
            hardStopLossRuleEnabled: CONFIG.hardStopLossEnabled,
            isOORRight: pos.isOORRight,
            isOORLeft: pos.isOORLeft,
            currentPnlSol: pos.pnl?.pnlSol ?? null,
            currentPnlPercent: pos.pnl?.pnlPercent ?? null,
            pnlSource: pos.pnl?.source ?? null,
            peakPnlSol: peakPnl?.pnlSol ?? null,
            peakPnlPercent: peakPnl?.pnlPercent ?? null,
            peakPnlAt: peakPnl?.timestamp ?? null,
            trailingTp: trailingArmed ? "ON" : "OFF",
            trailingArmed,
            shouldTrailingExit,
            trailingDropPercent,
            trailingArmPercent: CONFIG.trailingArmPercent,
            trailingDropThreshold: CONFIG.trailingDropPercent,
            positionAgeSeconds: Math.floor(positionAgeMs / 1000),
            cooldownSeconds: Math.floor(CONFIG.exitCooldownMs / 1000),
            cooldownPassed,
            ageSource,
          });

          // If RSI is 0, indicators couldn't be computed (not enough data)
          if (snapshot.rsi === 0 && snapshot.bb.upper === 0) {
            log("WARN", `Insufficient data for position ${posKey.slice(0, 8)}...`, {
              candlesCount: candles.length,
              price: snapshot.price.toFixed(8),
            });
            continue;
          }

          if ((snapshot.shouldExit || snapshot.shouldExitMacd) && !indicatorExitPnlOk) {
            log("INFO", "Indicator exit signal ignored below minimum PNL", {
              positionAddress: posKey,
              rsi: snapshot.rsi.toFixed(2),
              price: snapshot.price.toFixed(8),
              bbExitBand: CONFIG.bbExitBand,
              bbExitPrice: snapshot.bb[CONFIG.bbExitBand].toFixed(8),
              macdHistogram: snapshot.macd.histogram.toFixed(8),
              macdGreen: snapshot.shouldExitMacd,
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
              ageSource,
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
              hardStopLossEnabled: CONFIG.hardStopLossEnabled,
              hardStopLossPnlPercent: CONFIG.hardStopLossPnlPercent,
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
              hardStopLossEnabled: CONFIG.hardStopLossEnabled,
              hardStopLossPnlPercent: CONFIG.hardStopLossPnlPercent,
              macdEnabled: CONFIG.macdEnabled,
              macdLine: snapshot.macd.macdLine.toFixed(8),
              macdSignal: snapshot.macd.signalLine.toFixed(8),
              macdHistogram: snapshot.macd.histogram.toFixed(8),
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
              macdLine: snapshot.macd.macdLine,
              macdSignal: snapshot.macd.signalLine,
              macdHistogram: snapshot.macd.histogram,
              candleDataSource: snapshot.candleDataSource,
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
        safeNotify(
          () =>
            notifyExitStarted({
              positionAddress: posKey,
              tokenXSymbol: pos.tokenXSymbol,
              tokenYSymbol: pos.tokenYSymbol,
              trigger: exitTriggerType,
              pnl: pos.pnl,
              peakPnlSol: peakPnl?.pnlSol,
              peakPnlPercent: peakPnl?.pnlPercent,
              trailingDropPercent: exitSignal?.trailingDropPercent,
              candleDataSource: exitSignal?.candleDataSource,
              dryRun: CONFIG.dryRun,
            }),
          "exit started"
        );

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
              closeAttribution: result.closeAttribution ?? null,
              closeReason: result.closeReason ?? null,
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
                  macdLine: exitSignal?.macdLine,
                  macdSignal: exitSignal?.macdSignal,
                  macdHistogram: exitSignal?.macdHistogram,
                  peakPnlSol: exitSignal?.peakPnlSol,
                  peakPnlPercent: exitSignal?.peakPnlPercent,
                  trailingDropPercent: exitSignal?.trailingDropPercent,
                  candleDataSource: exitSignal?.candleDataSource,
                  swapResult: result.swapResult,
                  swapError: result.swapError,
                  closeAttribution: result.closeAttribution,
                  closeReason: result.closeReason,
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
                  closeAttribution: result.closeAttribution,
                  candleDataSource: exitSignal?.candleDataSource,
                });
              } catch (saveErr) {
                logError("saveExitRecord failed (non-fatal)", saveErr);
              }
            }
          } else {
            if (result.alreadyClosed && result.closeAttribution === "MANUAL_EXTERNAL") {
              const snapshot =
                getManualCloseSnapshots().find((s) => s.positionAddress === posKey) ??
                createManualCloseSnapshot(pos);
              saveManualCloseRecord(snapshot);
              tracked.state = "EXITED";
              tracked.exitTriggerType = undefined;
              tracked.exitSignal = undefined;
              log("WARN", "Position already closed externally during exit attempt", {
                positionAddress: posKey,
                triggerType: exitTriggerType,
                closeAttribution: result.closeAttribution,
                closeReason: result.closeReason,
                currentPnlSol: pos.pnl?.pnlSol ?? null,
                currentPnlPercent: pos.pnl?.pnlPercent ?? null,
              });
              safeNotify(
                () =>
                  notifyPositionClosedExternally({
                    positionAddress: posKey,
                    tokenXSymbol: pos.tokenXSymbol,
                    tokenYSymbol: pos.tokenYSymbol,
                    reason: result.closeReason ?? "Position already closed externally/manual",
                  }),
                "external close"
              );
              continue;
            }

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
    const remaining = getTrackedPositions().filter(
      (t) => t.state !== "EXITED"
    );
    if (remaining.length === 0 && getTrackedPositions().length > 0) {
      log("EXIT", "All positions exited. Agent shutting down.");
      await handleShutdown();
      break;
    }

    if (getTrackedPositions().length === 0) {
      log("INFO", "No positions to monitor");
    }

    // Rebuild snapshots for /positions command
    lastPositionSnapshots = getTrackedPositions()
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
