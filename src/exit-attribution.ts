const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export type CloseAttribution =
  | "BOT_CONFIRMED"
  | "BOT_UNCONFIRMED_BUT_CLOSED"
  | "MANUAL_EXTERNAL";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAlreadyClosedPositionError(err: unknown): boolean {
  const msg = errorMessage(err);
  return (
    /AccountOwnedByWrongProgram/i.test(msg) ||
    /owned by a different program than expected/i.test(msg) ||
    /custom program error:\s*0xbbf/i.test(msg) ||
    /Error Number:\s*3007/i.test(msg) ||
    msg.includes(SYSTEM_PROGRAM)
  );
}

export function classifyClosedAttribution(submittedSignatures: string[]): CloseAttribution {
  return submittedSignatures.length > 0 ? "BOT_UNCONFIRMED_BUT_CLOSED" : "MANUAL_EXTERNAL";
}

export { SYSTEM_PROGRAM };
