import assert from "node:assert/strict";
import test from "node:test";

async function loadExitExecutor() {
  return import("../src/exit-attribution");
}

async function loadTelegram() {
  return import("../src/telegram-format");
}

test("detects DLMM already-closed errors", async () => {
  const { isAlreadyClosedPositionError } = await loadExitExecutor();
  const cases = [
    "AnchorError caused by account: position. Error Code: AccountOwnedByWrongProgram.",
    "custom program error: 0xbbf",
    "Error Number: 3007. Error Message: The given account is owned by a different program than expected.",
    "Program log: Left:\n11111111111111111111111111111111",
  ];

  for (const message of cases) {
    assert.equal(isAlreadyClosedPositionError(new Error(message)), true, message);
  }
});

test("does not classify unrelated transaction failures as already closed", async () => {
  const { isAlreadyClosedPositionError } = await loadExitExecutor();
  const cases = [
    "429 Too Many Requests",
    "Blockhash not found",
    "insufficient funds for fee",
    "Transaction simulation failed: Error processing Instruction 1",
  ];

  for (const message of cases) {
    assert.equal(isAlreadyClosedPositionError(new Error(message)), false, message);
  }
});

test("attributes closed positions by submitted bot signatures", async () => {
  const { classifyClosedAttribution } = await loadExitExecutor();
  assert.equal(classifyClosedAttribution([]), "MANUAL_EXTERNAL");
  assert.equal(
    classifyClosedAttribution(["5TXsig"]),
    "BOT_UNCONFIRMED_BUT_CLOSED"
  );
});

test("escapes Telegram HTML dynamic text", async () => {
  const { escapeHtml } = await loadTelegram();
  assert.equal(
    escapeHtml('Simulation failed <tag attr="x"> & retry'),
    'Simulation failed &lt;tag attr="x"&gt; &amp; retry'
  );
});
