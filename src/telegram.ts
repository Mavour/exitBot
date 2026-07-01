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
const HARD_STOP_LOSS_PNL_PERCENT = -15;
const TELEGRAM_LONG_POLL_TIMEOUT_SECONDS = 25;
const TELEGRAM_FETCH_TIMEOUT_MS = 35_000;
const TELEGRAM_POLL_IDLE_DELAY_MS = 500;
const TELEGRAM_POLL_RETRY_BASE_MS = 2_000;
const TELEGRAM_POLL_RETRY_MAX_MS = 30_000;
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

export async function notifyExitSuccess(params: {
  positionAddress: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  receivedX: string;
  receivedY: string;
  txSignatures: string[];
  dryRun: boolean;
  pnl: PNLData | null;
  trigger?: "HARD_STOP_LOSS" | "RSI_BB" | "TRAILING_PROFIT";
  rsi?: number;
  price?: number;
  bbExitBand?: "upper" | "middle" | "lower";
  bbExitPrice?: number;
  peakPnlSol?: number;
  peakPnlPercent?: number;
  trailingDropPercent?: number;
  swapResult: SwapResult | null;
  swapError?: string;
}): Promise<void> {
  if (!enabled) return;
  const label = params.dryRun ? "🔍 EXIT SIMULATED" : "✅ EXIT SUCCESS";
  const lines: string[] = [
    `<b>${label}</b>`,
    "",
    `<b>Position:</b> <code>${params.positionAddress}</code>`,
  ];

  if (params.trigger) {
    const isTrailing = params.trigger === "TRAILING_PROFIT";
    const isHardStopLoss = params.trigger === "HARD_STOP_LOSS";
    const triggerLabel = isHardStopLoss
      ? "Hard Stop-Loss"
      : isTrailing
        ? "Trailing Profit"
        : "RSI+BB Indicator";
    const reason = isHardStopLoss
      ? `PNL <= ${HARD_STOP_LOSS_PNL_PERCENT}% hard stop-loss`
      : isTrailing
        ? `PNL dropped ${(params.trailingDropPercent ?? 0).toFixed(4)}% from peak after trailing armed at ${CONFIG.trailingArmPercent}%`
        : `RSI >= ${CONFIG.rsiThreshold}, price > BB ${params.bbExitBand ?? CONFIG.bbExitBand}, and PNL > ${CONFIG.indicatorExitMinPnlPercent}%`;

    lines.push(
      `<b>Trigger:</b> ${triggerLabel}`,
      `<b>Reason:</b> ${reason}`,
    );
    if (params.rsi !== undefined) lines.push(`<b>RSI(2):</b> ${params.rsi.toFixed(2)}`);
    if (params.price !== undefined) lines.push(`<b>Price:</b> ${params.price}`);
    if (params.bbExitBand && params.bbExitPrice !== undefined) {
      lines.push(`<b>BB ${params.bbExitBand}:</b> ${params.bbExitPrice}`);
    }
    if (isTrailing) {
      const peakPnlSol = params.peakPnlSol ?? 0;
      const peakPrefix = peakPnlSol >= 0 ? "+" : "";
      lines.push(
        `<b>Peak PNL:</b> ${(params.peakPnlPercent ?? 0).toFixed(4)}%`,
        `<b>Peak PNL SOL:</b> ${peakPrefix}${peakPnlSol.toFixed(7)} SOL`,
        `<b>Trailing drop:</b> ${(params.trailingDropPercent ?? 0).toFixed(4)}%`,
      );
    }
  }

  lines.push(
    "",
    "<b>💰 Received</b>",
    `${params.tokenXSymbol}: ${params.receivedX}`,
    `${params.tokenYSymbol}: ${params.receivedY}`,
  );

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

export async function notifyExitStarted(params: {
  positionAddress: string;
  poolAddress: string;
  trigger: "HARD_STOP_LOSS" | "RSI_BB" | "TRAILING_PROFIT";
  pnl: PNLData | null;
  peakPnlSol?: number;
  peakPnlPercent?: number;
  trailingDropPercent?: number;
  dryRun: boolean;
}): Promise<void> {
  if (!enabled) return;

  const isTrailing = params.trigger === "TRAILING_PROFIT";
  const isHardStopLoss = params.trigger === "HARD_STOP_LOSS";
  const triggerLabel = isHardStopLoss
    ? "Hard Stop-Loss"
    : isTrailing
      ? "Trailing Profit"
      : "RSI+BB Indicator";
  const reason = isHardStopLoss
    ? `PNL <= ${HARD_STOP_LOSS_PNL_PERCENT}% hard stop-loss`
    : isTrailing
      ? `PNL dropped ${(params.trailingDropPercent ?? 0).toFixed(4)}% from peak after trailing armed at ${CONFIG.trailingArmPercent}%`
      : `RSI >= ${CONFIG.rsiThreshold}, price > BB ${CONFIG.bbExitBand}, and PNL > ${CONFIG.indicatorExitMinPnlPercent}%`;

  const lines = [
    `<b>${params.dryRun ? "EXIT SIMULATION STARTED" : "EXIT STARTED"}</b>`,
    "",
    `<b>Position:</b> <code>${params.positionAddress}</code>`,
    `<b>Pool:</b> <code>${params.poolAddress}</code>`,
    `<b>Trigger:</b> ${triggerLabel}`,
    `<b>Reason:</b> ${reason}`,
  ];

  if (params.pnl) {
    const prefix = params.pnl.pnlSol >= 0 ? "+" : "";
    lines.push(
      "",
      "<b>Current PNL</b>",
      `${params.pnl.pnlPercent.toFixed(4)}% (${prefix}${params.pnl.pnlSol.toFixed(7)} SOL)`,
    );
  }

  if (params.peakPnlPercent !== undefined || params.peakPnlSol !== undefined) {
    const peakPrefix = (params.peakPnlSol ?? 0) >= 0 ? "+" : "";
    lines.push(
      "",
      "<b>Peak PNL</b>",
      `${(params.peakPnlPercent ?? 0).toFixed(4)}% (${peakPrefix}${(params.peakPnlSol ?? 0).toFixed(7)} SOL)`,
    );
  }

  lines.push("", "Status: exit transaction is being built and submitted.");
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

function isTransientTelegramPollError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("econnreset") ||
    message.includes("enetunreach") ||
    message.includes("eai_again")
  );
}

function telegramPollBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.min(consecutiveFailures - 1, 4);
  return Math.min(
    TELEGRAM_POLL_RETRY_BASE_MS * 2 ** exponent,
    TELEGRAM_POLL_RETRY_MAX_MS
  );
}

async function getUpdates(offset: number): Promise<any[]> {
  const url = `${TELEGRAM_API}/bot${CONFIG.telegramBotToken}/getUpdates?offset=${offset}&timeout=${TELEGRAM_LONG_POLL_TIMEOUT_SECONDS}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TELEGRAM_FETCH_TIMEOUT_MS),
  });
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

  let consecutiveFailures = 0;

  while (true) {
    let delayMs = TELEGRAM_POLL_IDLE_DELAY_MS;
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        fs.writeFileSync(OFFSET_FILE, String(offset));
        await handleUpdate(update);
      }
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      delayMs = telegramPollBackoffMs(consecutiveFailures);
      if (isTransientTelegramPollError(err)) {
        log("WARN", "Telegram update poll transient failure", {
          error: err instanceof Error ? err.message : String(err),
          consecutiveFailures,
          retryInMs: delayMs,
        });
      } else {
        logError("Telegram update poll failed", err);
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
}
