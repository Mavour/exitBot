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

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const timestamp = formatTimestamp();
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  const line = `[${timestamp}] [${level}] ${message}${metaStr}`;

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
