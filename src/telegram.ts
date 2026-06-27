import fs from "fs";
import { log, logError } from "./logger";
import { CONFIG } from "./config";
import { PNLData } from "./position-fetcher";
import { SwapResult } from "./jupiter-swap";
import {
  handleMenuCommand,
  handleStatusCommand,
  handlePositionsCommand,
  handleRecapCommand,
  handleTextInput,
  handleCallbackQuery,
  handleStartCommand,
  handleCancelCommand,
  pendingInput,
  isAuthorized,
} from "./telegram-menu";

const TELEGRAM_API = "https://api.telegram.org";
const LOCK_FILE = "/tmp/dlmm-exit-agent-menu.lock";
const OFFSET_FILE = "/tmp/dlmm-exit-agent-offset.txt";
let enabled = false;

function parseAmount(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value.toFixed(9).replace(/\.?0+$/, "");
}

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

export async function setupBotCommands(): Promise<void> {
  if (!enabled) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const commandsUrl = `${TELEGRAM_API}/bot${CONFIG.telegramBotToken}/setMyCommands`;
      const commandsRes = await fetch(commandsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commands: [
            { command: "menu", description: "⚙️ Bot Configuration" },
            { command: "positions", description: "📍 Active Positions" },
            { command: "recap", description: "📋 Exit History Recap" },
            { command: "status", description: "📊 Bot Status" },
            { command: "start", description: "🔄 Restart Bot" },
          ],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!commandsRes.ok) {
        throw new Error(`setMyCommands HTTP ${commandsRes.status}`);
      }

      const menuUrl = `${TELEGRAM_API}/bot${CONFIG.telegramBotToken}/setChatMenuButton`;
      const menuRes = await fetch(menuUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CONFIG.telegramChatId,
          menu_button: { type: "commands" },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!menuRes.ok) {
        throw new Error(`setChatMenuButton HTTP ${menuRes.status}`);
      }

      log("INFO", "Telegram bot commands registered");
      return;
    } catch (err) {
      logError(`Failed to register bot commands (attempt ${attempt}/3)`, err);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }
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
  exitCooldownMs: number;
  indicatorExitMinPnlPercent: number;
  trailingArmPercent: number;
  trailingDropPercent: number;
}): Promise<void> {
  if (!enabled) return;
  const msg = [
    "<b>🤖 Exit Agent Started</b>",
    "",
    `Positions monitored: ${params.positionsCount}`,
    `Mode: ${params.dryRun ? "🔍 DRY RUN" : "🔴 LIVE"}`,
    `RSI threshold: ${params.rsiThreshold}`,
    `Poll interval: ${(params.pollIntervalMs / 1000).toFixed(0)}s`,
    `Exit cooldown: ${(params.exitCooldownMs / 60_000).toFixed(0)} min`,
    `Indicator min PNL: > ${params.indicatorExitMinPnlPercent}%`,
    `Trailing: arm ${params.trailingArmPercent}% / drop ${params.trailingDropPercent}%`,
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

export async function notifyOORUnknown(params: {
  positionAddress: string;
  poolAddress: string;
  rsi: number;
  bbUpper: number;
  price: number;
}): Promise<void> {
  if (!enabled) return;
  const msg = [
    "<b>⚠️ OUT OF RANGE — DIRECTION UNKNOWN</b>",
    "",
    `<b>Position:</b> <code>${params.positionAddress}</code>`,
    `<b>Pool:</b> <code>${params.poolAddress}</code>`,
    `<b>RSI(2):</b> ${params.rsi.toFixed(2)}`,
    `<b>BB Upper:</b> ${params.bbUpper}`,
    `<b>Price:</b> ${params.price}`,
    "Status: OOR but direction could not be determined — monitoring for exit signal",
  ].join("\n");
  await sendMessage(msg);
}

export async function notifyBackInRange(params: {
  positionAddress: string;
  poolAddress: string;
  rsi: number;
  bbUpper: number;
  price: number;
}): Promise<void> {
  if (!enabled) return;
  const msg = [
    "<b>✅ BACK IN RANGE</b>",
    "",
    `<b>Position:</b> <code>${params.positionAddress}</code>`,
    `<b>Pool:</b> <code>${params.poolAddress}</code>`,
    `<b>RSI(2):</b> ${params.rsi.toFixed(2)}`,
    `<b>BB Upper:</b> ${params.bbUpper}`,
    `<b>Price:</b> ${params.price}`,
    "Status: Position is now back in range — fees accumulating",
  ].join("\n");
  await sendMessage(msg);
}

export async function notifyExitTriggered(params: {
  positionAddress: string;
  poolAddress: string;
  rsi: number;
  price: number;
  bbExitBand: "upper" | "middle" | "lower";
  bbExitPrice: number;
  trigger: "RSI_BB" | "TRAILING_PROFIT";
  pnl: PNLData | null;
  peakPnlPercent?: number;
  trailingDropPercent?: number;
}): Promise<void> {
  if (!enabled) return;
  const lines: string[] = [
    "<b>🚀 EXIT TRIGGERED</b>",
    "",
    `<b>Position:</b> <code>${params.positionAddress}</code>`,
    `<b>Pool:</b> <code>${params.poolAddress}</code>`,
    `<b>Trigger:</b> ${params.trigger === "TRAILING_PROFIT" ? "Trailing Profit" : "📊 RSI+BB Signal"}`,
    `<b>RSI(2):</b> ${params.rsi.toFixed(2)}`,
    `<b>Price:</b> ${params.price}`,
    `<b>BB ${params.bbExitBand}:</b> ${params.bbExitPrice}`,
  ];
  if (params.trigger === "TRAILING_PROFIT") {
    lines.push(
      `<b>Peak PNL:</b> ${(params.peakPnlPercent ?? 0).toFixed(4)}%`,
      `<b>Trailing drop:</b> ${(params.trailingDropPercent ?? 0).toFixed(4)}%`,
    );
  }
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
  swapError?: string;
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
      const dlmmSolReceived =
        (params.tokenXSymbol.toUpperCase() === "SOL" ? parseAmount(params.receivedX) : 0) +
        (params.tokenYSymbol.toUpperCase() === "SOL" ? parseAmount(params.receivedY) : 0);
      const finalSolReceived = dlmmSolReceived + parseAmount(params.swapResult.outputAmount);

      lines.push(
        "",
        "<b>Final Received</b>",
        `SOL: ${formatAmount(finalSolReceived)}`,
      );

      lines.push(
        "",
        "<b>🔄 Auto-Swap</b>",
        `✅ Swapped ${params.swapResult.inputAmount} ${params.swapResult.inputSymbol} → ${params.swapResult.outputAmount} SOL`,
      );
    } else {
      const reason = params.swapResult.reason || params.swapError || "unknown";
      const residualToken =
        params.swapResult.inputMint ||
        params.swapResult.inputSymbol ||
        (params.tokenXSymbol !== "SOL" ? params.tokenXSymbol : params.tokenYSymbol);
      lines.push(
        "",
        "<b>🔄 Auto-Swap</b>",
        `⚠️ Swap skipped: ${reason}`,
        "Tokens remain in wallet. Sell manually via Jupiter UI:",
        `<a href="https://jup.ag/swap/${residualToken}-SOL">Open Jupiter</a>`,
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
    const msgId = update.callback_query.message?.message_id;
    await handleCallbackQuery(
      chatId,
      update.callback_query.data,
      update.callback_query.id,
      msgId
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
  } else if (text === "/positions") {
    await handlePositionsCommand(chatId);
  } else if (text === "/recap") {
    await handleRecapCommand(chatId);
  } else if (text === "/start") {
    await handleStartCommand(chatId);
  } else if (text === "/cancel") {
    await handleCancelCommand(chatId);
  }
}

async function startCommandListener(): Promise<void> {
  if (fs.existsSync(LOCK_FILE)) {
    const existingPid = fs.readFileSync(LOCK_FILE, "utf-8").trim();
    try {
      process.kill(Number(existingPid), 0);
      log("INFO", "Command listener already running in another instance, skipping");
      return;
    } catch {
      fs.unlinkSync(LOCK_FILE);
    }
  }

  fs.writeFileSync(LOCK_FILE, String(process.pid));

  const cleanup = () => {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  let offset = 0;
  try {
    offset = Number(fs.readFileSync(OFFSET_FILE, "utf-8"));
  } catch {}

  while (true) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        fs.writeFileSync(OFFSET_FILE, String(offset));
        await handleUpdate(update);
      }
    } catch (err) {
      logError("Telegram update poll failed", err);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
