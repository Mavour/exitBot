import crypto from "crypto";
import { CONFIG } from "./config";
import { log, logError } from "./logger";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OHLCCandle {
  t: number; o: number; h: number; l: number; c: number; v: number;
}

const GMGN_BASE = "https://openapi.gmgn.ai";
const DEXPAPRIKA_BASE = "https://api.dexpaprika.com";
const MIN_CANDLES_REQUIRED = 20;

function isRateLimitError(err: unknown): boolean {
  return (err as { status?: number })?.status === 429;
}

function resolutionToMs(resolution: string): number {
  const match = /^(\d+)(m|h)$/.exec(resolution);
  if (!match) {
    throw new Error(`DexPaprika: unsupported interval "${resolution}"`);
  }
  const value = Number(match[1]);
  return match[2] === "h"
    ? value * 60 * 60 * 1000
    : value * 60 * 1000;
}

async function fetchGMGNKline(
  mint: string,
  resolution: string,
  limit: number
): Promise<OHLCCandle[]> {
  const ts = Math.floor(Date.now() / 1000);
  const cid = crypto.randomUUID();
  const url = `${GMGN_BASE}/v1/market/token_kline?chain=sol&address=${mint}&resolution=${resolution}&limit=${limit}&timestamp=${ts}&client_id=${cid}`;

  let lastError: Error = new Error("No attempts made");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "X-APIKEY": CONFIG.gmgnApiKey },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(
          `GMGN HTTP ${res.status}: ${text.slice(0, 120)}`
        ) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }

      const json = (await res.json()) as any;
      const list = json?.data?.list;

      if (!Array.isArray(list) || list.length < 10) {
        throw new Error(
          `GMGN insufficient data: got ${list?.length ?? 0} candles`
        );
      }

      return list
        .map((c: any) => ({
          t: Number(c.time),
          o: Number(c.open),
          h: Number(c.high),
          l: Number(c.low),
          c: Number(c.close),
          v: Number(c.volume),
        }))
        .filter((c: OHLCCandle) => Number.isFinite(c.c) && c.c > 0);
    } catch (err) {
      lastError = err as Error;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
  }
  throw lastError;
}

async function fetchDexPaprikaKlineUncached(
  poolAddress: string,
  resolution: string,
  limit: number
): Promise<OHLCCandle[]> {
  if (!poolAddress) {
    throw new Error("DexPaprika: poolAddress is required for OHLCV fallback");
  }
  const intervalMs = resolutionToMs(resolution);
  const startMs = Date.now() - intervalMs * limit;
  const url =
    `${DEXPAPRIKA_BASE}/networks/solana/pools/${encodeURIComponent(poolAddress)}` +
    `/ohlcv?start=${encodeURIComponent(new Date(startMs).toISOString())}` +
    `&interval=${encodeURIComponent(resolution)}&limit=${limit}`;

  let lastError: Error = new Error("No attempts made");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(
          `DexPaprika HTTP ${res.status}: ${text.slice(0, 120)}`
        ) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }

      const json = (await res.json()) as any;

      if (!Array.isArray(json) || json.length < MIN_CANDLES_REQUIRED) {
        throw new Error(
          `DexPaprika insufficient data: got ${
            Array.isArray(json) ? json.length : 0
          } candles`
        );
      }

      return json
        .map((c: any) => ({
          t: Math.floor(new Date(c.time_open).getTime() / 1000),
          o: Number(c.open),
          h: Number(c.high),
          l: Number(c.low),
          c: Number(c.close),
          v: Number(c.volume),
        }))
        .filter((c: OHLCCandle) => Number.isFinite(c.c) && c.c > 0);
    } catch (err) {
      lastError = err as Error;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  throw lastError;
}

export async function getCandles(
  tokenMint: string,
  limit: number = 60,
  poolAddress?: string
): Promise<{ candles: Candle[]; source: "GMGN" | "DEXPAPRIKA" }> {
  const fetchLimit = Math.max(limit + 10, MIN_CANDLES_REQUIRED + 10);

  let raw: OHLCCandle[];
  let source: "GMGN" | "DEXPAPRIKA";
  try {
    raw = await fetchGMGNKline(tokenMint, CONFIG.candleTimeframe, fetchLimit);
    source = "GMGN";
  } catch (err) {
    if (isRateLimitError(err) && poolAddress) {
      log("WARN", "GMGN rate limited, falling back to DexPaprika", {
        mint: tokenMint,
        poolAddress,
      });
      try {
        raw = await fetchDexPaprikaKlineUncached(
          poolAddress,
          CONFIG.candleTimeframe,
          fetchLimit
        );
        source = "DEXPAPRIKA";
      } catch (fallbackErr) {
        logError("DexPaprika fallback also failed", fallbackErr);
        throw err;
      }
    } else {
      throw err;
    }
  }

  raw.sort((a, b) => a.t - b.t);

  const candles: Candle[] = raw.map((c) => ({
    timestamp: c.t * 1000,
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
    volume: c.v,
  }));

  if (candles.length < MIN_CANDLES_REQUIRED) {
    throw new Error(
      `Insufficient candle data for ${tokenMint.slice(0, 8)}: ` +
        `got ${candles.length}, need ${MIN_CANDLES_REQUIRED}`
    );
  }

  return { candles: candles.slice(-limit), source };
}

export function toOHLC(candles: Candle[]): OHLCCandle[] {
  return candles.map((c) => ({
    t: c.timestamp,
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    v: c.volume,
  }));
}
