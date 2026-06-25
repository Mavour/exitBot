import { log, logError } from "./logger";
import { CONFIG } from "./config";
import { wallet } from "./wallet";
import { connection } from "./wallet";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getExitHistory, ExitRecord } from "./exit-history";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

const TELEGRAM_API = "https://api.telegram.org";

interface ParamConfig {
  envKey: string;
  label: string;
  unit: string;
  validate: (v: string) => boolean;
  errorMsg: string;
  restartRequired: boolean;
  transform?: (v: string) => string;
}

const PARAMS: Record<string, ParamConfig> = {
  timeframe: {
    envKey: "CANDLE_TIMEFRAME",
    label: "Timeframe",
    unit: "",
    validate: (v) => ["1m", "3m", "5m", "15m", "30m", "1h", "4h"].includes(v),
    errorMsg: "Valid values: 1m, 3m, 5m, 15m, 30m, 1h, 4h",
    restartRequired: true,
  },
  rsiPeriod: {
    envKey: "RSI_PERIOD",
    label: "RSI Period",
    unit: "",
    validate: (v) => Number.isInteger(+v) && +v >= 1 && +v <= 50,
    errorMsg: "Must be integer between 1-50",
    restartRequired: true,
  },
  rsiThreshold: {
    envKey: "RSI_THRESHOLD",
    label: "RSI Threshold",
    unit: "",
    validate: (v) => +v >= 50 && +v <= 100,
    errorMsg: "Must be between 50-100",
    restartRequired: true,
  },
  bbPeriod: {
    envKey: "BB_PERIOD",
    label: "BB Period",
    unit: "",
    validate: (v) => Number.isInteger(+v) && +v >= 5 && +v <= 200,
    errorMsg: "Must be integer between 5-200",
    restartRequired: true,
  },
  bbStdDev: {
    envKey: "BB_STD_DEV",
    label: "BB StdDev",
    unit: "σ",
    validate: (v) => +v >= 0.5 && +v <= 4,
    errorMsg: "Must be between 0.5-4",
    restartRequired: true,
  },
  bbExitBand: {
    envKey: "BB_EXIT_BAND",
    label: "BB Exit Band",
    unit: "",
    validate: (v) => ["upper", "middle", "mid", "lower"].includes(v.toLowerCase()),
    errorMsg: "Valid values: upper, middle, mid, lower",
    restartRequired: true,
    transform: (v) => (v.toLowerCase() === "mid" ? "middle" : v.toLowerCase()),
  },
  pollInterval: {
    envKey: "POLL_INTERVAL_MS",
    label: "Poll Interval",
    unit: "s",
    validate: (v) => Number.isInteger(+v) && +v >= 10 && +v <= 300,
    errorMsg: "Must be integer between 10-300 seconds",
    restartRequired: true,
    transform: (v) => String(+v * 1000),
  },
  exitCooldown: {
    envKey: "EXIT_COOLDOWN_MINUTES",
    label: "Exit Cooldown",
    unit: "min",
    validate: (v) => Number.isInteger(+v) && +v >= 0 && +v <= 60,
    errorMsg: "Must be integer between 0-60 minutes",
    restartRequired: true,
  },
  slippage: {
    envKey: "SLIPPAGE_BPS",
    label: "Slippage",
    unit: "%",
    validate: (v) => +v >= 0.1 && +v <= 10,
    errorMsg: "Must be between 0.1%-10%",
    restartRequired: true,
    transform: (v) => String(Math.round(+v * 100)),
  },
  dryRun: {
    envKey: "DRY_RUN",
    label: "DRY RUN",
    unit: "",
    validate: (v) =>
      ["true", "false", "on", "off", "yes", "no"].includes(v.toLowerCase()),
    errorMsg: "Send: true or false",
    restartRequired: true,
    transform: (v) =>
      ["true", "on", "yes"].includes(v.toLowerCase()) ? "true" : "false",
  },
};

interface PendingInput {
  param: string;
  prompt: string;
  validate: (val: string) => boolean;
  errorMsg: string;
}

const pendingInput = new Map<number, PendingInput>();

function isAuthorized(chatId: number): boolean {
  return chatId.toString() === CONFIG.telegramChatId;
}

function getCurrentValue(paramKey: string): string {
  const config = PARAMS[paramKey];
  const envVal = process.env[config.envKey];
  if (envVal !== undefined && envVal !== "") {
    if (paramKey === "pollInterval") return String(Math.round(+envVal / 1000));
    if (paramKey === "slippage") return String(+envVal / 100);
    if (paramKey === "dryRun") {
      return ["true", "1", "on", "yes"].includes(envVal.toLowerCase())
        ? "true"
        : "false";
    }
    return envVal;
  }
  switch (paramKey) {
    case "timeframe":
      return "15m";
    case "rsiPeriod":
      return String(CONFIG.rsiPeriod);
    case "rsiThreshold":
      return String(CONFIG.rsiThreshold);
    case "bbPeriod":
      return String(CONFIG.bbPeriod);
    case "bbStdDev":
      return String(CONFIG.bbStdDev);
    case "bbExitBand":
      return CONFIG.bbExitBand;
    case "pollInterval":
      return String(CONFIG.pollIntervalMs / 1000);
    case "exitCooldown":
      return String(CONFIG.exitCooldownMs / 60_000);
    case "slippage":
      return String(CONFIG.slippageBps / 100);
    case "dryRun":
      return CONFIG.dryRun ? "true" : "false";
    default:
      return "";
  }
}

async function sendTelegramMessage(
  text: string,
  chatId: string,
  replyMarkup?: any
): Promise<void> {
  try {
    const url = `${TELEGRAM_API}/bot${CONFIG.telegramBotToken}/sendMessage`;
    const body: any = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (text.includes("<")) body.parse_mode = "HTML";
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logError(
        "Telegram API error",
        new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
      );
    }
  } catch (err) {
    logError("Telegram send failed", err);
  }
}

async function editTelegramMessage(
  text: string,
  chatId: string,
  messageId: number,
  replyMarkup?: any
): Promise<void> {
  try {
    const url = `${TELEGRAM_API}/bot${CONFIG.telegramBotToken}/editMessageText`;
    const body: any = {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
    };
    if (text.includes("<")) body.parse_mode = "HTML";
    if (replyMarkup) body.reply_markup = replyMarkup;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    logError("Telegram editMessage failed", err);
  }
}

async function deleteTelegramMessage(
  chatId: string,
  messageId: number
): Promise<void> {
  try {
    const url = `${TELEGRAM_API}/bot${CONFIG.telegramBotToken}/deleteMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    logError("Telegram deleteMessage failed", err);
  }
}

async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  try {
    const url = `${TELEGRAM_API}/bot${CONFIG.telegramBotToken}/answerCallbackQuery`;
    const body: any = { callback_query_id: callbackQueryId };
    if (text) body.text = text;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    logError("Failed to answer callback query", err);
  }
}

function buildMainMenuKeyboard() {
  const rows: any[][] = [];
  rows.push([
    {
      text: `📊 Timeframe: ${getCurrentValue("timeframe")}`,
      callback_data: "param_timeframe",
    },
  ]);
  rows.push([
    {
      text: `📈 RSI Period: ${getCurrentValue("rsiPeriod")}`,
      callback_data: "param_rsiPeriod",
    },
    {
      text: `🎯 RSI Threshold: ${getCurrentValue("rsiThreshold")}`,
      callback_data: "param_rsiThreshold",
    },
  ]);
  rows.push([
    {
      text: `📉 BB Period: ${getCurrentValue("bbPeriod")}`,
      callback_data: "param_bbPeriod",
    },
    {
      text: `〰️ BB StdDev: ${getCurrentValue("bbStdDev")}`,
      callback_data: "param_bbStdDev",
    },
  ]);
  rows.push([
    {
      text: `🎚 BB Exit: ${getCurrentValue("bbExitBand")}`,
      callback_data: "param_bbExitBand",
    },
  ]);
  rows.push([
    {
      text: `⏱ Poll Interval: ${getCurrentValue("pollInterval")}s`,
      callback_data: "param_pollInterval",
    },
  ]);
  rows.push([
    {
      text: `Exit Cooldown: ${getCurrentValue("exitCooldown")} min`,
      callback_data: "param_exitCooldown",
    },
  ]);
  rows.push([
    {
      text: `💧 Slippage: ${getCurrentValue("slippage")}%`,
      callback_data: "param_slippage",
    },
  ]);
  rows.push([
    {
      text: `🔍 DRY RUN: ${getCurrentValue("dryRun").toUpperCase()}`,
      callback_data: "param_dryRun",
    },
  ]);
  rows.push([
    { text: "❌ Close", callback_data: "close" },
  ]);
  return { inline_keyboard: rows };
}

export async function handleMenuCommand(chatId: number): Promise<void> {
  if (!isAuthorized(chatId)) return;
  const keyboard = buildMainMenuKeyboard();
  await sendTelegramMessage(
    "⚙️ Bot Configuration",
    String(chatId),
    keyboard
  );
}

export async function handleStatusCommand(chatId: number): Promise<void> {
  if (!isAuthorized(chatId)) return;
  const mode = CONFIG.dryRun ? "🔍 DRY RUN" : "🔴 LIVE";
  const msg = [
    "<b>📊 Bot Status</b>",
    "",
    `Mode: ${mode}`,
    "",
    "<b>⚙️ Current Config</b>",
    `Timeframe: ${getCurrentValue("timeframe")}`,
    `RSI: period=${getCurrentValue("rsiPeriod")}, threshold=${getCurrentValue("rsiThreshold")}`,
    `BB: period=${getCurrentValue("bbPeriod")}, stddev=${getCurrentValue("bbStdDev")}σ, exit=${getCurrentValue("bbExitBand")}`,
    `Poll: ${getCurrentValue("pollInterval")}s`,
    `Exit cooldown: ${getCurrentValue("exitCooldown")} min`,
    `Slippage: ${getCurrentValue("slippage")}%`,
  ].join("\n");
  await sendTelegramMessage(msg, String(chatId));
}

export async function handleCallbackQuery(
  chatId: number,
  callbackData: string,
  callbackQueryId: string,
  messageId?: number
): Promise<void> {
  if (!isAuthorized(chatId)) return;

  if (callbackData === "close") {
    await answerCallbackQuery(callbackQueryId, "Menu closed");
    return;
  }

  if (callbackData.startsWith("recap_")) {
    if (callbackData === "recap_close") {
      await answerCallbackQuery(callbackQueryId, "Closed");
      if (messageId) {
        await deleteTelegramMessage(String(chatId), messageId);
      }
      return;
    }
    if (callbackData === "recap_nop") {
      await answerCallbackQuery(callbackQueryId, "");
      return;
    }
    if (callbackData.startsWith("recap_page_")) {
      const page = parseInt(callbackData.slice(11), 10);
      if (isNaN(page) || !messageId) {
        await answerCallbackQuery(callbackQueryId, "Error");
        return;
      }

      const history = getExitHistory();
      const totalPages = Math.ceil(history.length / ITEMS_PER_PAGE) || 1;

      let balanceSol = 0;
      try {
        const balance = await connection.getBalance(wallet.publicKey);
        balanceSol = balance / LAMPORTS_PER_SOL;
      } catch {}

      const lines = formatRecapLines(history, page);
      lines.splice(1, 0, `💰 Balance: ${balanceSol.toFixed(4)} SOL`);

      const keyboard = buildRecapKeyboard(page, totalPages);
      await answerCallbackQuery(callbackQueryId, `Page ${page + 1}`);
      await editTelegramMessage(lines.join("\n"), String(chatId), messageId, keyboard);
      return;
    }
  }

  if (callbackData.startsWith("param_")) {
    const paramKey = callbackData.slice(6);
    const config = PARAMS[paramKey];
    if (!config) {
      await answerCallbackQuery(callbackQueryId, "Unknown parameter");
      return;
    }

    const currentVal = getCurrentValue(paramKey);
    const prompt = [
      `Send new <b>${config.label}</b> value:`,
      `Valid: ${config.errorMsg.toLowerCase().replace("must be ", "")}`,
      `Current: ${currentVal}${config.unit ? " " + config.unit : ""}`,
    ].join("\n");

    pendingInput.set(chatId, {
      param: paramKey,
      prompt,
      validate: config.validate,
      errorMsg: config.errorMsg,
    });

    await answerCallbackQuery(callbackQueryId, `Enter new ${config.label}`);
    await sendTelegramMessage(prompt, String(chatId));
  }
}

export async function handleTextInput(
  chatId: number,
  text: string
): Promise<void> {
  if (!isAuthorized(chatId)) return;

  const pending = pendingInput.get(chatId);
  if (!pending) return;

  const config = PARAMS[pending.param];
  if (!config) {
    pendingInput.delete(chatId);
    return;
  }

  const trimmed = text.trim();
  if (!pending.validate(trimmed)) {
    await sendTelegramMessage(
      `❌ ${pending.errorMsg}\n\nTry again or send /cancel`,
      String(chatId)
    );
    return;
  }

  pendingInput.delete(chatId);

  const finalValue = config.transform
    ? config.transform(trimmed)
    : trimmed;
  const displayValue = config.transform ? trimmed : finalValue;
  const oldValue = getCurrentValue(pending.param);

  updateEnvFile(config.envKey, finalValue);

  await sendTelegramMessage(
    `✅ ${config.label} updated: ${oldValue}${config.unit ? " " + config.unit : ""} → ${displayValue}${config.unit ? " " + config.unit : ""}`,
    String(chatId)
  );

  await restartBot(chatId);
}

export async function handleStartCommand(chatId: number): Promise<void> {
  if (!isAuthorized(chatId)) return;
  await sendTelegramMessage("🔄 Restarting bot...", String(chatId));
  await new Promise((r) => setTimeout(r, 1500));
  try { fs.unlinkSync("/tmp/dlmm-exit-agent-menu.lock"); } catch {}
  try {
    execSync("pm2 restart dlmm-exit-agent", { stdio: "ignore" });
  } catch {
    // Process killed by PM2 restart — expected
  }
}

export async function handleCancelCommand(chatId: number): Promise<void> {
  if (!isAuthorized(chatId)) return;
  if (pendingInput.has(chatId)) {
    pendingInput.delete(chatId);
    await sendTelegramMessage("❌ Input cancelled", String(chatId));
  }
}

export async function handlePositionsCommand(chatId: number): Promise<void> {
  if (!isAuthorized(chatId)) return;

  await sendTelegramMessage("🔄 Fetching positions...", String(chatId));

  try {
    const url = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${wallet.publicKey.toBase58()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = (await res.json()) as any;
    const pools = data?.pools ?? [];
    const totalPositions = data?.total?.totalPositions ?? 0;

    if (totalPositions === 0 || pools.length === 0) {
      await sendTelegramMessage("📍 No active positions being monitored.", String(chatId));
      return;
    }

    let totalValue = 0;
    const lines: string[] = [`<b>📍 Active Positions (${totalPositions})</b>`, ""];

    for (const pool of pools) {
      const posAddr = pool.listPositions?.[0] ?? "N/A";
      const shortPos = posAddr.slice(0, 8) + "..." + posAddr.slice(-4);
      const pnlSol = parseFloat(pool.pnlSol ?? "0");
      const pnlPct = parseFloat(pool.pnlSolPctChange ?? "0");
      const balanceSol = parseFloat(pool.balancesSol ?? "0");
      const feesSol = parseFloat(pool.unclaimedFeesSol ?? "0");
      const isOOR = pool.outOfRange === true;

      totalValue += balanceSol;

      lines.push(
        `<b>${pool.tokenX ?? "?"}/${pool.tokenY ?? "?"}</b>`,
        `   Position: <code>${shortPos}</code>`,
        `   Balance: ${balanceSol.toFixed(4)} SOL`,
        `   PNL: ${pnlSol >= 0 ? "🟢 +" : "🔴 "}${pnlSol.toFixed(7)} SOL (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(4)}%)`,
        `   Fees: ${feesSol.toFixed(6)} SOL`,
        `   Status: ${isOOR ? "⚠️ Out of Range" : "✅ In Range"}`,
        `   ${"─".repeat(16)}`,
      );
    }

    lines.push(`💼 <b>Total Value: ${totalValue.toFixed(4)} SOL</b>`);
    await sendTelegramMessage(lines.join("\n"), String(chatId));
  } catch (err) {
    await sendTelegramMessage(
      `❌ Failed to fetch positions\nError: ${String(err).slice(0, 100)}`,
      String(chatId)
    );
  }
}

const ITEMS_PER_PAGE = 10;

function isEstimatedManualRecord(record: ExitRecord): boolean {
  return record.estimated === true || record.exitSource === "MANUAL";
}

function buildRecapKeyboard(page: number, totalPages: number) {
  const row: any[] = [];
  if (totalPages <= 1) {
    row.push({ text: "❌ Close", callback_data: "recap_close" });
    return { inline_keyboard: [row] };
  }
  const prevDisabled = page === 0;
  const nextDisabled = page >= totalPages - 1;
  row.push({
    text: prevDisabled ? "◀️ Prev" : "◀️ Prev",
    callback_data: prevDisabled ? "recap_nop" : `recap_page_${page - 1}`,
  });
  row.push({
    text: `[${page + 1}/${totalPages}]`,
    callback_data: "recap_nop",
  });
  row.push({
    text: nextDisabled ? "Next ▶️" : "Next ▶️",
    callback_data: nextDisabled ? "recap_nop" : `recap_page_${page + 1}`,
  });
  return {
    inline_keyboard: [
      row,
      [{ text: "❌ Close", callback_data: "recap_close" }],
    ],
  };
}

function formatRecapLines(history: ExitRecord[], page: number): string[] {
  const totalCount = history.length;
  const officialHistory = history.filter((r) => !isEstimatedManualRecord(r));
  const estimatedCount = history.length - officialHistory.length;
  const totalPnlSol = officialHistory.reduce((sum, r) => sum + r.pnlSol, 0);
  const totalFees = officialHistory.reduce((sum, r) => sum + r.totalFeeEarnedSol, 0);
  const pnlSign = totalPnlSol >= 0 ? "🟢 +" : "🔴 ";
  const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE) || 1;

  const lines: string[] = [
    "<b>📋 Exit Recap</b>",
    "",
    `Total Closed: ${totalCount}`,
    `Total PNL: ${pnlSign}${totalPnlSol.toFixed(4)} SOL`,
    `Total Fees Earned: ${totalFees.toFixed(4)} SOL`,
    ...(estimatedCount > 0 ? [`Manual estimates excluded: ${estimatedCount}`] : []),
    "",
    `── Page ${page + 1}/${totalPages} ──`,
    "",
  ];

  const start = page * ITEMS_PER_PAGE;
  const end = Math.min(start + ITEMS_PER_PAGE, totalCount);
  const pageItems = history.slice(start, end);

  for (let i = 0; i < pageItems.length; i++) {
    const r = pageItems[i];
    const num = start + i + 1;
    const pnlSign = r.pnlSol >= 0 ? "🟢 +" : "🔴 ";
    const pnlPctSign = r.pnlPercent >= 0 ? "+" : "";
    const date = r.timestamp.slice(0, 16).replace("T", " ");
    const estimatedManual = isEstimatedManualRecord(r);
    lines.push(
      `${num}. <b>${r.tokenXSymbol}/${r.tokenYSymbol}</b>`,
      estimatedManual
        ? `   PNL: estimate ${pnlSign}${r.pnlSol.toFixed(4)} SOL (${pnlPctSign}${r.pnlPercent.toFixed(2)}%)`
        : `   PNL: ${pnlSign}${r.pnlSol.toFixed(4)} SOL (${pnlPctSign}${r.pnlPercent.toFixed(2)}%)`,
      estimatedManual
        ? `   Fees: estimate ${r.totalFeeEarnedSol.toFixed(4)} SOL`
        : `   Fees: ${r.totalFeeEarnedSol.toFixed(4)} SOL`,
      ...(estimatedManual ? ["   Source: Manual close (cached estimate)"] : []),
      `   ${date}`,
    );
  }

  if (totalCount === 0) {
    lines.push("No exit history yet.");
  }

  return lines;
}

export async function handleRecapCommand(chatId: number): Promise<void> {
  if (!isAuthorized(chatId)) return;

  const history = getExitHistory();
  const totalPages = Math.ceil(history.length / ITEMS_PER_PAGE) || 1;
  const page = 0;

  let balanceSol = 0;
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    balanceSol = balance / LAMPORTS_PER_SOL;
  } catch {}

  const lines = formatRecapLines(history, page);
  lines.splice(1, 0, `💰 Balance: ${balanceSol.toFixed(4)} SOL`);

  const keyboard = buildRecapKeyboard(page, totalPages);
  await sendTelegramMessage(lines.join("\n"), String(chatId), keyboard);
}

export { pendingInput, isAuthorized };

function updateEnvFile(envKey: string, newValue: string): void {
  const envPath = path.join(process.cwd(), ".env");
  let content = "";
  try {
    content = fs.readFileSync(envPath, "utf-8");
  } catch {
    // File doesn't exist, will create new
  }
  const regex = new RegExp(`^${envKey}=.*`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${envKey}=${newValue}`);
  } else {
    content += `${content ? "\n" : ""}${envKey}=${newValue}`;
  }
  fs.writeFileSync(envPath, content, "utf-8");
  log("INFO", `.env updated: ${envKey}=${newValue}`);
}

async function restartBot(chatId: number): Promise<void> {
  await sendTelegramMessage(
    "🔄 Applying changes and restarting bot...\nYou will receive a new <b>Exit Agent Started</b> notification when ready.",
    String(chatId)
  );

  await new Promise((r) => setTimeout(r, 1500));

  try { fs.unlinkSync("/tmp/dlmm-exit-agent-menu.lock"); } catch {}
  try {
    execSync("pm2 restart dlmm-exit-agent", { stdio: "ignore" });
  } catch {
    // Process killed by PM2 restart — expected
  }
}
