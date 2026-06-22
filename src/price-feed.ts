import crypto from "crypto";
import { CONFIG } from "./config";

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
const MIN_CANDLES_REQUIRED = 60;

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
        throw new Error(`GMGN HTTP ${res.status}: ${text.slice(0, 120)}`);
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

export async function getCandles15m(
  tokenMint: string,
  limit: number = 60
): Promise<Candle[]> {
  const fetchLimit = Math.max(limit + 10, MIN_CANDLES_REQUIRED + 10);
  const raw = await fetchGMGNKline(tokenMint, "15m", fetchLimit);

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

  return candles.slice(-limit);
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
