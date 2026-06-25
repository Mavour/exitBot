import * as fs from "fs";
import * as path from "path";
import { log } from "./logger";

export interface ExitRecord {
  timestamp: string;
  exitSource?: "BOT" | "MANUAL";
  positionAddress: string;
  poolAddress: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  receivedX: string;
  receivedY: string;
  pnlPercent: number;
  pnlSol: number;
  peakPnlSol?: number;
  peakPnlPercent?: number;
  peakPnlAt?: string;
  totalFeeEarnedSol: number;
  depositValueSol: number;
  dryRun: boolean;
  swapSuccess: boolean | null;
  swapReason: string | null;
  estimated?: boolean;
}

const HISTORY_FILE = path.resolve(__dirname, "..", "logs", "exit-history.json");

function ensureDir(): void {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function saveExitRecord(record: ExitRecord): void {
  try {
    ensureDir();
    let history: ExitRecord[] = [];
    try {
      const raw = fs.readFileSync(HISTORY_FILE, "utf-8");
      history = JSON.parse(raw);
      if (!Array.isArray(history)) history = [];
    } catch {}
    history.push(record);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf-8");
    log("INFO", "Exit record saved", { positionAddress: record.positionAddress });
  } catch (err) {
    log("ERROR", "Failed to save exit record", { error: String(err) });
  }
}

export function getExitHistory(): ExitRecord[] {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function hasExitRecord(positionAddress: string): boolean {
  return getExitHistory().some((r) => r.positionAddress === positionAddress);
}
