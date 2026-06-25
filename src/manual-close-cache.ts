import * as fs from "fs";
import * as path from "path";
import { ExitRecord } from "./exit-history";
import { ActivePosition, PNLData } from "./position-fetcher";
import { log } from "./logger";

export interface ManualCloseSnapshot {
  timestamp: string;
  positionAddress: string;
  poolAddress: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  pnlPercent: number;
  pnlSol: number;
  peakPnlSol?: number;
  peakPnlPercent?: number;
  peakPnlAt?: string;
  totalFeeEarnedSol: number;
  depositValueSol: number;
}

const SNAPSHOT_FILE = path.resolve(
  __dirname,
  "..",
  "logs",
  "active-position-snapshots.json"
);

function ensureDir(): void {
  const dir = path.dirname(SNAPSHOT_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function fallbackPnl(): PNLData {
  return {
    depositValueSol: 0,
    currentValueSol: 0,
    totalFeeEarnedSol: 0,
    pnlSol: 0,
    pnlPercent: 0,
  };
}

export function createManualCloseSnapshot(
  position: ActivePosition
): ManualCloseSnapshot {
  const pnl = position.pnl ?? fallbackPnl();
  return {
    timestamp: new Date().toISOString(),
    positionAddress: position.positionPubkey.toBase58(),
    poolAddress: position.poolAddress.toBase58(),
    tokenXSymbol: position.tokenXSymbol,
    tokenYSymbol: position.tokenYSymbol,
    pnlPercent: pnl.pnlPercent,
    pnlSol: pnl.pnlSol,
    peakPnlSol: pnl.pnlSol,
    peakPnlPercent: pnl.pnlPercent,
    peakPnlAt: new Date().toISOString(),
    totalFeeEarnedSol: pnl.totalFeeEarnedSol,
    depositValueSol: pnl.depositValueSol,
  };
}

export function getManualCloseSnapshots(): ManualCloseSnapshot[] {
  try {
    const raw = fs.readFileSync(SNAPSHOT_FILE, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function saveActivePositionSnapshots(positions: ActivePosition[]): void {
  try {
    ensureDir();
    const byPosition = new Map<string, ManualCloseSnapshot>();
    for (const snapshot of getManualCloseSnapshots()) {
      byPosition.set(snapshot.positionAddress, snapshot);
    }
    for (const position of positions) {
      const snapshot = createManualCloseSnapshot(position);
      const existing = byPosition.get(snapshot.positionAddress);
      if (
        existing?.peakPnlSol !== undefined &&
        existing.peakPnlSol > (snapshot.peakPnlSol ?? Number.NEGATIVE_INFINITY)
      ) {
        snapshot.peakPnlSol = existing.peakPnlSol;
        snapshot.peakPnlPercent = existing.peakPnlPercent;
        snapshot.peakPnlAt = existing.peakPnlAt;
      }
      byPosition.set(snapshot.positionAddress, snapshot);
    }
    fs.writeFileSync(
      SNAPSHOT_FILE,
      JSON.stringify(Array.from(byPosition.values()), null, 2),
      "utf-8"
    );
    log("INFO", "Active position snapshots saved", { count: positions.length });
  } catch (err) {
    log("ERROR", "Failed to save active position snapshots", {
      error: String(err),
    });
  }
}

export function snapshotToManualExitRecord(
  snapshot: ManualCloseSnapshot,
  reason = "Manual close detected on-chain"
): ExitRecord {
  return {
    timestamp: new Date().toISOString(),
    exitSource: "MANUAL",
    positionAddress: snapshot.positionAddress,
    poolAddress: snapshot.poolAddress,
    tokenXSymbol: snapshot.tokenXSymbol,
    tokenYSymbol: snapshot.tokenYSymbol,
    receivedX: "0",
    receivedY: "0",
    pnlPercent: snapshot.pnlPercent,
    pnlSol: snapshot.pnlSol,
    peakPnlSol: snapshot.peakPnlSol,
    peakPnlPercent: snapshot.peakPnlPercent,
    peakPnlAt: snapshot.peakPnlAt,
    totalFeeEarnedSol: snapshot.totalFeeEarnedSol,
    depositValueSol: snapshot.depositValueSol,
    dryRun: false,
    swapSuccess: null,
    swapReason: reason,
    estimated: true,
  };
}
