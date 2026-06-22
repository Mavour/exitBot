import dotenv from "dotenv";
dotenv.config();

import { CONFIG } from "./config";
import { wallet } from "./wallet";
import { startMonitor } from "./monitor";
import { initTelegram, setupBotCommands } from "./telegram";
import { log, logError } from "./logger";

function printBanner(): void {
  const pubkey = wallet.publicKey.toBase58();
  const truncated = pubkey.slice(0, 8) + "..." + pubkey.slice(-4);
  const mode = CONFIG.dryRun ? "[DRY RUN]" : "[LIVE]";

  console.log("╔════════════════════════════════════╗");
  console.log("║     DLMM EXIT AGENT v2.0.0        ║");
  console.log(`║  Wallet: ${truncated.padEnd(21)}║`);
  console.log(`║  Mode: ${mode.padEnd(24)}║`);
  console.log("╚════════════════════════════════════╝");
}

async function main(): Promise<void> {
  printBanner();

  log("INFO", "Agent starting", {
    mode: CONFIG.dryRun ? "DRY RUN" : "LIVE",
    pollIntervalMs: CONFIG.pollIntervalMs,
    rsiPeriod: CONFIG.rsiPeriod,
    rsiThreshold: CONFIG.rsiThreshold,
    bbPeriod: CONFIG.bbPeriod,
    bbStdDev: CONFIG.bbStdDev,
  });

  initTelegram();
  await setupBotCommands();
  await startMonitor();
}

// Handle uncaught exceptions gracefully
process.on("uncaughtException", (err) => {
  logError("Uncaught exception", err);
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled rejection", reason);
});

main().catch((err) => {
  logError("Fatal error in main", err);
  process.exit(1);
});
