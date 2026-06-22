import "dotenv/config";
import { startCommandListener } from "./telegram-menu";
import { log, logError } from "./logger";

log("INFO", "Telegram command listener started");
startCommandListener().catch((err) => {
  logError("Command listener fatal error", err);
  process.exit(1);
});
