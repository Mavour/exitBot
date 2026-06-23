import dotenv from "dotenv";
import { Commitment } from "@solana/web3.js";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseNumber(
  name: string,
  defaultValue: number,
  min?: number
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number(raw);
  if (isNaN(parsed) || (min !== undefined && parsed < min)) {
    throw new Error(
      `Invalid ${name}: must be a number${min !== undefined ? ` >= ${min}` : ""}`
    );
  }
  return parsed;
}

function parseBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`Invalid ${name}: must be true/false or 1/0`);
}

function parseCommitment(name: string, defaultValue: Commitment): Commitment {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const valid: Commitment[] = ["processed", "confirmed", "finalized"];
  if (valid.includes(raw as Commitment)) return raw as Commitment;
  throw new Error(
    `Invalid ${name}: must be one of ${valid.join(", ")}`
  );
}

export const CONFIG = {
  rpcUrl: requireEnv("RPC_URL"),
  rpcUrlFallback1: process.env.RPC_URL_FALLBACK_1 || 'https://api.mainnet-beta.solana.com',
  rpcUrlFallback2: process.env.RPC_URL_FALLBACK_2 || 'https://solana-mainnet.g.alchemy.com/v2/demo',
  walletPrivateKey: requireEnv("WALLET_PRIVATE_KEY"),
  pollIntervalMs: parseNumber("POLL_INTERVAL_MS", 60000, 1000),
  dryRun: parseBool("DRY_RUN", true),
  rsiPeriod: parseNumber("RSI_PERIOD", 2, 1),
  rsiThreshold: parseNumber("RSI_THRESHOLD", 90, 1),
  bbPeriod: parseNumber("BB_PERIOD", 20, 2),
  bbStdDev: parseNumber("BB_STD_DEV", 2, 0.1),
  priorityFeeMicrolamports: parseNumber(
    "PRIORITY_FEE_MICROLAMPORTS",
    10000,
    0
  ),
  computeUnitLimit: parseNumber(
    "COMPUTE_UNIT_LIMIT",
    600000,
    0
  ),
  slippageBps: parseNumber("SLIPPAGE_BPS", 100, 0),
  commitment: parseCommitment("COMMITMENT", "confirmed"),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  candleTimeframe: process.env.CANDLE_TIMEFRAME || "15m",
  gmgnApiKey: process.env.GMGN_API_KEY || "",
  autoSwapMinUsd: 0.10,
} as const;
