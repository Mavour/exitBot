import * as fs from "fs";
import * as path from "path";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "EXIT";

const LOG_DIR = path.resolve(__dirname, "..", "logs");
const LOG_RETENTION_DAYS = 30;

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function logFilePath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `exit-agent-${date}.log`);
}

function cleanOldLogs(): void {
  try {
    ensureLogDir();
    const files = fs.readdirSync(LOG_DIR);
    const now = Date.now();
    const cutoff = now - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (!file.startsWith("exit-agent-") || !file.endsWith(".log")) continue;
      const filePath = path.join(LOG_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {
    // Silently fail cleanup
  }
}

const COLORS: Record<LogLevel, string> = {
  INFO: "\x1b[36m",
  WARN: "\x1b[33m",
  ERROR: "\x1b[31m",
  EXIT: "\x1b[35m",
};

const RESET = "\x1b[0m";

function formatTimestamp(): string {
  return new Date().toISOString();
}

function writeToFile(line: string): void {
  try {
    ensureLogDir();
    fs.appendFileSync(logFilePath(), line + "\n", "utf-8");
  } catch {
    // Silently fail file write
  }
}

function fmtNum(value: unknown, digits: number): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "?";
}

function fmtPct(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "?%";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtSol(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "? SOL";
  return `${n >= 0 ? "+" : ""}${n.toFixed(5)} SOL`;
}

function compactMeta(meta?: Record<string, unknown>): string {
  if (!meta) return "";
  const entries = Object.entries(meta)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return entries ? ` ${entries}` : "";
}

function formatConsoleMessage(message: string, meta?: Record<string, unknown>): string {
  if (!meta) return message;

  if (message.startsWith("Position ") && "currentPnlPercent" in meta) {
    const range = meta.isOORRight
      ? "OOR-R"
      : meta.isOORLeft
        ? "OOR-L"
        : "IN";
    const indicator = meta.shouldExit ? "RSI_BB=YES" : "RSI_BB=no";
    const trailing = meta.trailingTp === "ON"
      ? `TRAIL=ON drop=${fmtPct(meta.trailingDropPercent)}/${fmtPct(meta.trailingDropThreshold)}`
      : "TRAIL=off";
    const cooldown = meta.cooldownPassed ? "cd=ok" : `cd=${meta.positionAgeSeconds ?? "?"}/${meta.cooldownSeconds ?? "?"}s`;
    return [
      message,
      `PNL ${fmtPct(meta.currentPnlPercent)} (${fmtSol(meta.currentPnlSol)})`,
      `peak ${fmtPct(meta.peakPnlPercent)}`,
      range,
      `RSI ${fmtNum(meta.rsi, 2)}`,
      `price ${meta.price ?? "?"}`,
      indicator,
      trailing,
      cooldown,
      `src=${meta.pnlSource ?? "?"}`,
    ].join(" | ");
  }

  if (message === "OOR status") {
    const range = meta.isOORRight
      ? "RIGHT"
      : meta.isOORLeft
        ? "LEFT"
        : meta.isInRange
          ? "IN"
          : "UNKNOWN";
    return [
      `OOR ${range}`,
      String(meta.positionAddress ?? "").slice(0, 8),
      `active=${meta.activeBinId ?? "?"}`,
      `range=${meta.fromBinId ?? "?"}..${meta.toBinId ?? "?"}`,
      `api=${meta.apiOOR ? "OOR" : "ok"}`,
    ].join(" | ");
  }

  if (message === "Position is OUT-OF-RANGE RIGHT" || message === "Position is OUT-OF-RANGE LEFT") {
    return [
      message.replace("Position is ", ""),
      String(meta.positionAddress ?? "").slice(0, 8),
      `price=${meta.price ?? "?"}`,
    ].join(" | ");
  }

  if (message.startsWith("Poll cycle")) {
    return `${message}${compactMeta(meta)}`;
  }

  if (message === "Fetching positions from Meteora Data API") {
    return "Fetching Meteora positions";
  }

  return `${message}${compactMeta(meta)}`;
}

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const timestamp = formatTimestamp();
  const line = `[${timestamp}] [${level}] ${formatConsoleMessage(message, meta)}`;

  const color = COLORS[level];
  console.log(`${color}${line}${RESET}`);

  const jsonLine = JSON.stringify({
    timestamp,
    level,
    message,
    ...(meta || {}),
  });
  writeToFile(jsonLine);
}

export function logError(message: string, error: unknown): void {
  const errorStr =
    error instanceof Error
      ? `${error.message}\n${error.stack || ""}`
      : String(error);
  log("ERROR", message, { error: errorStr });
}

// Run cleanup on module load
cleanOldLogs();
