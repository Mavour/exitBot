import { log, logError } from "./logger";
import { CONFIG } from "./config";
import { PNLData } from "./position-fetcher";
import { SwapResult } from "./jupiter-swap";
import {
  handleMenuCommand,
  handleStatusCommand,
  handleTextInput,
  handleCallbackQuery,
  handleStopCommand,
  handleStartCommand,
  handleCancelCommand,
  pendingInput,
  isAuthorized,
} from "./telegram-menu";

const TELEGRAM_API = "https://api.telegram.org";
let enabled = false;

export function initTelegram(): void {
  if (CONFIG.telegramBotToken && CONFIG.telegramChatId) {
    enabled = true;
    log("INFO", "Telegram notifications enabled");
    startCommandListener().catch((err) =>
      logError("Command listener error", err)
    );
  } else {
    log("INFO", "Telegram not configured, skipping");
  }
}

async function sendMessage(text: string): Promise<void> {
  if (!enabled) return;
  try {
    const url = `${TELEGRAM_API}/bot${CONFIG.telegramBotToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.telegramChatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logError("Telegram API error", new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`));
    }
  } catch (err) {
    logError("Telegram send failed", err);
  }
}

export async function notifyAgentStart(params: {
  positionsCount: number;
  dryRun: boolean;
  rsiThreshold: number;
  pollIntervalMs: number;
}): Promise<void> {
  if (!enabled) return;
  const msg = [
    "<b>🤖 Exit Agent Started</b>",
    "",
    `Positions monitored: ${params.positionsCount}`,
    `Mode: ${params.dryRun ? "🔍 DRY RUN" : "🔴 LIVE"}`,
    `RSI threshold: ${params.rsiThreshold}`,
    `Poll interval: ${(params.pollIntervalMs / 1000).toFixed(0)}s`,
  ].join("\n");
  await sendMessage(msg);
}

export async function notifyOORRight(params: {
  positionAddress: string;
  poolAddress: string;
  rsi: number;
  bbUpper: number;
  price: number;
}): Promise<void> {
  if (!enabled) return;
  const msg = [
    "<b>⚠️ OUT OF RANGE — RIGHT</b>",
    "",
    `<b>Position:</b> <code>${params.positionAddress}</code>`,
    `<b>Pool:</b> <code>${params.poolAddress}</code>`,
    `<b>RSI(2):</b> ${params.rsi.toFixed(2)}`,
    `<b>BB Upper:</b> ${params.bbUpper}`,
    `<b>Price:</b> ${params.price}`,
    "Status: 100% TOKEN — monitoring for exit signal",
  ].join("\n");
  await sendMessage(msg);
}

export async function notifyOORLeft(params: {
  positionAddress: string;
  poolAddress: string;
  rsi: number;
  bbUpper: number;
  price: number;
}): Promise<void> {
  if (!enabled) return;
  const msg = [
    "<b>⚠️ OUT OF RANGE — LEFT</b>",
    "",
    `<b>Position:</b> <code>${params.positionAddress}</code>`,
    `<b>Pool:</b> <code>${params.poolAddress}</code>`,
    `<b>RSI(2):</b> ${params.rsi.toFixed(2)}`,
    `<b>BB Upper:</b> ${params.bbUpper}`,
    `<b>Price:</b> ${params.price}`,
    "Status: 100% SOL — monitoring for exit signal",
  ].join("\n");
  await sendMessage(msg);
}

export async function notifyExitTriggered(params: {
  positionAddress: string;
  poolAddress: string;
  rsi: number;
  price: number;
  bbUpper: number;
  trigger: "RSI_BB";
  pnl: PNLData | null;
}): Promise<void> {
  if (!enabled) return;
  const lines: string[] = [
    "<b>🚀 EXIT TRIGGERED</b>",
    "",
    `<b>Position:</b> <code>${params.positionAddress}</code>`,
    `<b>Pool:</b> <code>${params.poolAddress}</code>`,
    `<b>Trigger:</b> 📊 RSI+BB Signal`,
    `<b>RSI(2):</b> ${params.rsi.toFixed(2)}`,
    `<b>Price:</b> ${params.price}`,
    `<b>BB Upper:</b> ${params.bbUpper}`,
  ];
  if (params.pnl) {
    const sign = params.pnl.pnlPercent >= 0 ? "🟢" : "🔴";
    const prefix = params.pnl.pnlSol >= 0 ? "+" : "";
    lines.push(
      `<b>PNL:</b> ${sign} ${params.pnl.pnlPercent.toFixed(4)}% (${prefix}${params.pnl.pnlSol.toFixed(7)} SOL)`,
    );
  }
  await sendMessage(lines.join("\n"));
}

export async function notifyExitSuccess(params: {
  positionAddress: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  receivedX: string;
  receivedY: string;
  txSignatures: string[];
  dryRun: boolean;
  pnl: PNLData | null;
  swapResult: SwapResult | null;
}): Promise<void> {
  if (!enabled) return;
  const label = params.dryRun ? "🔍 EXIT SIMULATED" : "✅ EXIT SUCCESS";
  const lines: string[] = [
    `<b>${label}</b>`,
    "",
    `<b>Position:</b> <code>${params.positionAddress}</code>`,
    "",
    "<b>💰 Received</b>",
    `${params.tokenXSymbol}: ${params.receivedX}`,
    `${params.tokenYSymbol}: ${params.receivedY}`,
  ];
  if (params.pnl) {
    const sign = params.pnl.pnlPercent >= 0 ? "🟢" : "🔴";
    const prefix = params.pnl.pnlSol >= 0 ? "+" : "";
    lines.push(
      "",
      "<b>📊 PNL</b>",
      `${sign} ${params.pnl.pnlPercent.toFixed(4)}% (${prefix}${params.pnl.pnlSol.toFixed(7)} SOL)`,
      `Fees earned: ${params.pnl.totalFeeEarnedSol.toFixed(4)} SOL`,
      `Deposit: ${params.pnl.depositValueSol.toFixed(4)} SOL`,
    );
  }
  if (params.swapResult && !params.dryRun) {
    if (params.swapResult.success) {
      lines.push(
        "",
        "<b>🔄 Auto-Swap</b>",
        `✅ Swapped ${params.swapResult.inputAmount} ${params.swapResult.inputSymbol} → ${params.swapResult.outputAmount} SOL`,
      );
    } else {
      lines.push(
        "",
        "<b>🔄 Auto-Swap</b>",
        `⚠️ Swap skipped: ${params.swapResult.reason}`,
      );
    }
  }
  if (!params.dryRun) {
    lines.push(
      "",
      `<a href="https://solscan.io/account/${params.positionAddress}">🔗 View on Solscan</a>`,
    );
  }
  await sendMessage(lines.join("\n"));
}

export async function notifyExitFailed(params: {
  positionAddress: string;
  error: string;
}): Promise<void> {
  if (!enabled) return;
  const msg = [
    "<b>❌ EXIT FAILED</b>",
    "",
    `<b>Position:</b> <code>${params.positionAddress}</code>`,
    `<b>Error:</b> ${params.error.slice(0, 500)}`,
  ].join("\n");
  await sendMessage(msg);
}

async function getUpdates(offset: number): Promise<any[]> {
  const url = `${TELEGRAM_API}/bot${CONFIG.telegramBotToken}/getUpdates?offset=${offset}&timeout=10`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`Telegram getUpdates HTTP ${res.status}`);
  }
  const json = (await res.json()) as any;
  return json.result ?? [];
}

async function handleUpdate(update: any): Promise<void> {
  const chatId =
    update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  if (!chatId || !isAuthorized(chatId)) return;

  if (update.callback_query) {
    await handleCallbackQuery(
      chatId,
      update.callback_query.data,
      update.callback_query.id
    );
    return;
  }

  const text = (update.message?.text ?? "").trim();
  if (!text) return;

  if (pendingInput.has(chatId)) {
    await handleTextInput(chatId, text);
    return;
  }

  if (text === "/menu") {
    await handleMenuCommand(chatId);
  } else if (text === "/status") {
    await handleStatusCommand(chatId);
  } else if (text === "/stop") {
    await handleStopCommand(chatId);
  } else if (text === "/start") {
    await handleStartCommand(chatId);
  } else if (text === "/cancel") {
    await handleCancelCommand(chatId);
  }
}

async function startCommandListener(): Promise<void> {
  let offset = 0;
  while (true) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (err) {
      logError("Telegram update poll failed", err);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
