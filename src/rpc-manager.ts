import { Connection, ConnectionConfig } from "@solana/web3.js";
import { CONFIG } from "./config";

const RPC_TIMEOUT_MS = 10_000;

const connectionConfig: ConnectionConfig = {
  commitment: CONFIG.commitment,
  confirmTransactionInitialTimeout: 60_000,
};

const connections: { url: string; conn: Connection; failCount: number }[] = [
  { url: CONFIG.rpcUrl,           conn: new Connection(CONFIG.rpcUrl, connectionConfig),           failCount: 0 },
  { url: CONFIG.rpcUrlFallback1,  conn: new Connection(CONFIG.rpcUrlFallback1, connectionConfig),  failCount: 0 },
  { url: CONFIG.rpcUrlFallback2,  conn: new Connection(CONFIG.rpcUrlFallback2, connectionConfig),  failCount: 0 },
];

let activeIndex = 0;

export function getConnection(): Connection {
  return connections[activeIndex].conn;
}

export function reportRpcFailure(error: Error): void {
  const isRateLimit = error.message.includes('429') || error.message.includes('rate limit');
  const isTimeout   = error.message.includes('timeout') || error.message.includes('ETIMEDOUT');

  if (isRateLimit || isTimeout) {
    connections[activeIndex].failCount++;
    const next = (activeIndex + 1) % connections.length;
    if (next !== activeIndex) {
      console.warn(`[RPC] Rotating from ${connections[activeIndex].url} to ${connections[next].url}`);
      activeIndex = next;
    }
  }
}

setInterval(() => {
  if (activeIndex !== 0) {
    console.info('[RPC] Attempting to restore primary RPC connection');
    activeIndex = 0;
    connections.forEach(c => c.failCount = 0);
  }
}, 10 * 60 * 1000);

export async function withRpcFallback<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < connections.length; attempt++) {
    const idx = (activeIndex + attempt) % connections.length;
    try {
      const result = await withTimeout(
        fn(connections[idx].conn),
        RPC_TIMEOUT_MS,
        `RPC timeout after ${RPC_TIMEOUT_MS}ms`
      );
      if (attempt > 0) activeIndex = idx;
      return result;
    } catch (err) {
      reportRpcFailure(err as Error);
      if (attempt === connections.length - 1) throw err;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('All RPC connections failed');
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
