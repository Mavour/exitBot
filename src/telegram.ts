import { log, logError } from "./logger";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let enabled = false;
let startTime = Date.now();

export function initTelegram(): void {
  if (BOT_TOKEN && CHAT_ID) {
    enabled = true;
    log("INFO", "Telegram notifications enabled");
  } else {
    log(
      "INFO",
      "Telegram disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable"
    );
  }
}

function fmt(val: string | number, decimals = 6): string {
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(n)) return String(val);
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toFixed(decimals);
}

export async function sendTelegramMessage(text: string): Promise<void> {
  if (!enabled || !BOT_TOKEN || !CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logError("Telegram API error", new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`));
    }
  } catch (err) {
    logError("Telegram send failed", err);
  }
}

export function notifyExitTriggered(
  posAddr: string,
  poolAddr: string,
  rsi: number,
  price: number,
  bbUpper: number
): void {
  const msg = [
    "<b>🚀 EXIT TRIGGERED</b>",
    "",
    `<b>Position:</b> <code>${posAddr}</code>`,
    `<b>Pool:</b> <code>${poolAddr}</code>`,
    `<b>RSI(2)+SMA(14):</b> ${rsi.toFixed(2)}`,
    `<b>Price:</b> ${fmt(price)}`,
    `<b>BB Upper:</b> ${fmt(bbUpper)}`,
  ].join("\n");
  sendTelegramMessage(msg);
}

export function notifyExitSuccess(
  posAddr: string,
  claimedFeeX: string,
  claimedFeeY: string,
  receivedX: string,
  receivedY: string,
  txCount: number,
  dryRun: boolean
): void {
  const label = dryRun ? "🔍 DRY RUN EXIT" : "✅ EXIT SUCCESS";
  const msg = [
    `<b>${label}</b>`,
    "",
    `<b>Position:</b> <code>${posAddr}</code>`,
    `<b>Claimed Fee X:</b> ${fmt(claimedFeeX)}`,
    `<b>Claimed Fee Y:</b> ${fmt(claimedFeeY)}`,
    `<b>Received X:</b> ${fmt(receivedX)}`,
    `<b>Received Y:</b> ${fmt(receivedY)}`,
    `<b>Tx count:</b> ${txCount}`,
    dryRun ? "" : `<b>Explorer:</b> <a href="https://solscan.io/account/${posAddr}">solscan</a>`,
  ].filter(Boolean).join("\n");
  sendTelegramMessage(msg);
}

export function notifyExitFailed(
  posAddr: string,
  error: string
): void {
  const msg = [
    "<b>❌ EXIT FAILED</b>",
    "",
    `<b>Position:</b> <code>${posAddr}</code>`,
    `<b>Error:</b> ${error.slice(0, 500)}`,
  ].join("\n");
  sendTelegramMessage(msg);
}

export function notifyAgentStart(
  positionsCount: number,
  dryRun: boolean,
  rsiThreshold: number,
  pollIntervalMs: number
): void {
  const msg = [
    "<b>🤖 Exit Agent Started</b>",
    "",
    `<b>Positions monitored:</b> ${positionsCount}`,
    `<b>Mode:</b> ${dryRun ? "🔍 DRY RUN" : "⚡ LIVE"}`,
    `<b>RSI threshold:</b> ${rsiThreshold}`,
    `<b>Poll interval:</b> ${(pollIntervalMs / 1000).toFixed(0)}s`,
  ].join("\n");
  sendTelegramMessage(msg);
}
