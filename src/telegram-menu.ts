import { log, logError } from "./logger";
import { CONFIG } from "./config";
import { lastPositionSnapshots } from "./monitor";
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
  pollInterval: {
    envKey: "POLL_INTERVAL_MS",
    label: "Poll Interval",
    unit: "s",
    validate: (v) => Number.isInteger(+v) && +v >= 10 && +v <= 300,
    errorMsg: "Must be integer between 10-300 seconds",
    restartRequired: true,
    transform: (v) => String(+v * 1000),
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
    case "pollInterval":
      return String(CONFIG.pollIntervalMs / 1000);
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
      text: `⏱ Poll Interval: ${getCurrentValue("pollInterval")}s`,
      callback_data: "param_pollInterval",
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
    `BB: period=${getCurrentValue("bbPeriod")}, stddev=${getCurrentValue("bbStdDev")}σ`,
    `Poll: ${getCurrentValue("pollInterval")}s`,
    `Slippage: ${getCurrentValue("slippage")}%`,
  ].join("\n");
  await sendTelegramMessage(msg, String(chatId));
}

export async function handleCallbackQuery(
  chatId: number,
  callbackData: string,
  callbackQueryId: string
): Promise<void> {
  if (!isAuthorized(chatId)) return;

  if (callbackData === "close") {
    await answerCallbackQuery(callbackQueryId, "Menu closed");
    return;
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

export async function handleStopCommand(chatId: number): Promise<void> {
  if (!isAuthorized(chatId)) return;
  await sendTelegramMessage("🛑 Stopping bot...", String(chatId));
  await new Promise((r) => setTimeout(r, 1000));
  try {
    execSync("pm2 stop dlmm-exit-agent", { stdio: "ignore" });
  } catch {
    // Expected - process killed by PM2
  }
}

export async function handleStartCommand(chatId: number): Promise<void> {
  if (!isAuthorized(chatId)) return;
  await sendTelegramMessage("▶️ Starting bot...", String(chatId));
  try {
    execSync("pm2 start dlmm-exit-agent", { stdio: "ignore" });
  } catch (err) {
    logError("Failed to start bot via PM2", err);
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

  const snapshots = lastPositionSnapshots;
  if (snapshots.length === 0) {
    await sendTelegramMessage(
      "📍 No active positions being monitored.",
      String(chatId)
    );
    return;
  }

  const lines: string[] = [
    `<b>📍 Active Positions (${snapshots.length})</b>`,
    "",
  ];

  let totalValue = 0;

  for (let i = 0; i < snapshots.length; i++) {
    const pos = snapshots[i];
    const pnl = pos.pnl;
    const pnlEmoji = pnl ? (pnl.pnlPercent >= 0 ? "🟢" : "🔴") : "";
    const pnlSign = pnl && pnl.pnlPercent >= 0 ? "+" : "";
    const pnlPct = pnl ? `${pnlSign}${pnl.pnlPercent.toFixed(4)}%` : "N/A";
    const pnlSol =
      pnl && pnl.pnlSol !== undefined
        ? `${pnl.pnlSol >= 0 ? "+" : ""}${pnl.pnlSol.toFixed(7)} SOL`
        : "";

    const inRangeStr = pos.isInRange
      ? "✅"
      : pos.isOORRight
        ? "🔴 OOR Right"
        : "🟡 OOR Left";

    const ageMs = Date.now() - pos.createdAt;
    const ageHours = Math.floor(ageMs / 3600000);
    const ageMins = Math.floor((ageMs % 3600000) / 60000);
    const ageStr =
      ageHours > 0 ? `${ageHours}h ${ageMins}m` : `${ageMins}m`;

    if (pnl) {
      totalValue += pnl.currentValueSol;
    }

    lines.push(
      `${i + 1}. <b>${pos.tokenXSymbol}/${pos.tokenYSymbol}</b>`,
      `   Position: <code>${pos.positionAddress.slice(0, 8)}...</code>`,
      `   Price: ${pos.price}`,
      `   RSI(${CONFIG.rsiPeriod}): ${pos.rsi.toFixed(2)}`,
      `   BB Upper: ${pos.bbUpper}`,
      `   In Range: ${inRangeStr}`,
      `   PNL: ${pnlEmoji} ${pnlPct} ${pnlSol}`.trim(),
      `   Age: ${ageStr}`,
      `   ${"─".repeat(16)}`,
    );
  }

  lines.push(`Total Value: ${totalValue.toFixed(4)} SOL`);

  await sendTelegramMessage(lines.join("\n"), String(chatId));
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

  try {
    execSync("pm2 restart dlmm-exit-agent", { stdio: "ignore" });
  } catch {
    // Process killed by PM2 restart — expected
  }
}
