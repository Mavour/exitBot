import { log, logError } from "./logger";
import { CONFIG } from "./config";
import { wallet } from "./wallet";
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
  await sendTelegramMessage(
    "🛑 <b>Bot stopped.</b>\nSend /start to resume monitoring.",
    String(chatId)
  );
  await new Promise((r) => setTimeout(r, 1500));
  try {
    execSync("pm2 stop dlmm-exit-agent --no-autorestart", { stdio: "ignore" });
  } catch {
    // process already stopped — ignore
  }
}

export async function handleStartCommand(chatId: number): Promise<void> {
  if (!isAuthorized(chatId)) return;
  try {
    const raw = execSync("pm2 jlist", {
      stdio: ["pipe", "pipe", "ignore"],
    }).toString();
    const procs = JSON.parse(raw) as any[];
    const proc = procs.find((p: any) => p.name === "dlmm-exit-agent");
    if (proc?.pm2_env?.status === "online") {
      await sendTelegramMessage(
        "⚠️ Bot is already running.\nUse /positions to check active positions.",
        String(chatId)
      );
      return;
    }
  } catch {
    // pm2 jlist failed — proceed to start
  }
  await sendTelegramMessage("▶️ Starting bot...", String(chatId));
  await new Promise((r) => setTimeout(r, 1500));
  try {
    execSync("pm2 start ecosystem.config.js", { stdio: "ignore" });
  } catch {
    execSync("pm2 restart dlmm-exit-agent", { stdio: "ignore" });
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
      await sendTelegramMessage(
        "📍 No active positions being monitored.",
        String(chatId)
      );
      return;
    }

    let msg = `<b>📍 Active Positions (${totalPositions})</b>\n\n`;

    for (const pool of pools) {
      const positionAddress = pool.listPositions?.[0] ?? "N/A";
      const shortPos =
        positionAddress.slice(0, 8) + "..." + positionAddress.slice(-4);
      const shortPool =
        pool.poolAddress.slice(0, 8) + "..." + pool.poolAddress.slice(-4);

      const pnlSol = parseFloat(pool.pnlSol ?? "0");
      const pnlPct = parseFloat(pool.pnlSolPctChange ?? "0") * 100;
      const pnlEmoji = pnlSol >= 0 ? "🟢" : "🔴";
      const pnlSign = pnlSol >= 0 ? "+" : "";

      const balanceSol = parseFloat(pool.balancesSol ?? "0").toFixed(4);
      const depositSol = parseFloat(pool.totalDepositSol ?? "0").toFixed(4);
      const unclaimedFees = parseFloat(pool.unclaimedFeesSol ?? "0").toFixed(6);
      const isOOR = pool.outOfRange === true;
      const rangeStatus = isOOR ? "⚠️ Out of Range" : "✅ In Range";

      const snapshot = lastPositionSnapshots.find(
        (s) => s.poolAddress === pool.poolAddress
      );
      const rsiStr = snapshot
        ? snapshot.rsi.toFixed(2)
        : "N/A (next poll)";
      const bbUpperStr = snapshot
        ? snapshot.bb.upper.toFixed(8)
        : "N/A (next poll)";
      const priceStr = snapshot
        ? snapshot.price.toFixed(8)
        : pool.poolPrice?.toFixed(8) ?? "N/A";

      msg += `<b>${pool.tokenX ?? "?"}/${pool.tokenY ?? "?"}</b>\n`;
      msg += `Position: <code>${shortPos}</code>\n`;
      msg += `Pool: <code>${shortPool}</code>\n`;
      msg += `Price: ${priceStr}\n`;
      msg += `RSI(${CONFIG.rsiPeriod}): ${rsiStr}\n`;
      msg += `BB Upper: ${bbUpperStr}\n`;
      msg += `Range: ${rangeStatus}\n`;
      msg += `PNL: ${pnlEmoji} ${pnlSign}${pnlPct.toFixed(4)}% (${pnlSign}${pnlSol.toFixed(7)} SOL)\n`;
      msg += `Fees: ${unclaimedFees} SOL\n`;
      msg += `Balance: ${balanceSol} SOL\n`;
      msg += `${"─".repeat(16)}\n`;
    }

    const totalSol = parseFloat(data?.total?.balancesSol ?? "0").toFixed(4);
    msg += `\n💼 <b>Total Value: ${totalSol} SOL</b>`;

    await sendTelegramMessage(msg, String(chatId));
  } catch (err) {
    await sendTelegramMessage(
      `❌ Failed to fetch positions\nError: ${String(err).slice(0, 100)}`,
      String(chatId)
    );
  }
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
