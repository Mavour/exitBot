import { log } from "./logger";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface DexScreenerChartEntry {
  timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface MeteoraOHLCVEntry {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MeteoraOHLCVResponse {
  start_time: number;
  end_time: number;
  data: MeteoraOHLCVEntry[];
}

interface DexScreenerSearchEntry {
  chainId: string;
  dexId: string;
  pairAddress: string;
}

interface DexScreenerSearchResponse {
  pairs: DexScreenerSearchEntry[];
}

const dexPairCache = new Map<string, string>();

async function fetchWithRetry(
  url: string,
  retries = 3
): Promise<Response> {
  let lastErr: Error | undefined;
  const delays = [1000, 2000, 4000];

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) return response;
      if (response.status === 429) {
        lastErr = new Error(`Rate limited (429) on ${url}`);
        if (attempt < retries) {
          const delay = delays[attempt] || 4000;
          log("WARN", `Rate limited, retrying in ${delay}ms`, {
            attempt: attempt + 1,
            maxRetries: retries,
          });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
      lastErr = new Error(`HTTP ${response.status} on ${url}`);
      if (attempt < retries) {
        const delay = delays[attempt] || 4000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw lastErr;
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        lastErr = new Error(`Timeout on ${url}`);
      } else if (err instanceof Error) {
        lastErr = err;
      } else {
        lastErr = new Error(String(err));
      }
      if (attempt < retries) {
        const delay = delays[attempt] || 4000;
        log("WARN", `Request failed, retrying in ${delay}ms`, {
          attempt: attempt + 1,
          maxRetries: retries,
        });
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }

  throw lastErr || new Error(`Failed after ${retries} retries: ${url}`);
}

async function resolveDexScreenerPairAddress(
  poolAddress: string
): Promise<string> {
  const cached = dexPairCache.get(poolAddress);
  if (cached) return cached;

  const url = `https://api.dexscreener.com/latest/dex/search?q=${poolAddress}`;
  const response = await fetchWithRetry(url);
  const data = (await response.json()) as DexScreenerSearchResponse;

  if (!data.pairs || data.pairs.length === 0) {
    throw new Error(`No DexScreener pairs found for pool ${poolAddress}`);
  }

  const match = data.pairs.find(
    (p) => p.chainId === "solana" && p.dexId === "meteora"
  );

  if (!match) {
    throw new Error(
      `No Meteora Solana pair found in DexScreener search for ${poolAddress}`
    );
  }

  dexPairCache.set(poolAddress, match.pairAddress);
  return match.pairAddress;
}

async function fetchDexScreenerCandles(
  pairAddress: string,
  limit: number
): Promise<Candle[]> {
  const cb = Date.now();
  const url = `https://api.dexscreener.com/latest/dex/chart/solana/${pairAddress}?res=15&cb=${cb}`;

  const response = await fetchWithRetry(url);
  const data = (await response.json()) as {
    schemaVersion: string;
    pairs: DexScreenerChartEntry[];
  };

  if (!data.pairs || !Array.isArray(data.pairs) || data.pairs.length < limit) {
    log("WARN", `DexScreener returned ${data.pairs?.length ?? 0} candles, need ${limit}`);
    throw new Error(
      `Insufficient candles: got ${data.pairs?.length ?? 0}, need ${limit}`
    );
  }

  const slices = data.pairs.slice(-limit);

  return slices.map((entry) => ({
    timestamp: entry.timestamp,
    open: parseFloat(entry.open),
    high: parseFloat(entry.high),
    low: parseFloat(entry.low),
    close: parseFloat(entry.close),
    volume: parseFloat(entry.volume),
  }));
}

async function fetchMeteoraCandles(
  poolAddress: string,
  limit: number
): Promise<Candle[]> {
  // Meteora 1m OHLCV → aggregate every 15 into one 15m candle
  const oneMinLimit = 900;
  const url = `https://dlmm.datapi.meteora.ag/pools/${poolAddress}/ohlcv?timeframe=1m&limit=${oneMinLimit}`;

  log("INFO", "Falling back to Meteora OHLCV API", { url });

  const response = await fetchWithRetry(url);
  const data = (await response.json()) as MeteoraOHLCVResponse;

  if (!data.data || data.data.length < 15) {
    throw new Error(
      `Meteora OHLCV returned ${data.data?.length ?? 0} 1m candles, need at least 15`
    );
  }

  const oneMinCandles = data.data.sort(
    (a, b) => a.timestamp - b.timestamp
  );

  // Aggregate 1m → 15m candles (group every 15)
  const candles15m: Candle[] = [];
  for (let i = 0; i + 14 < oneMinCandles.length; i += 15) {
    const group = oneMinCandles.slice(i, i + 15);
    candles15m.push({
      timestamp: group[0].timestamp,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
    });
  }

  return candles15m.slice(-limit);
}

export async function getCandles15m(
  poolAddress: string,
  limit: number
): Promise<Candle[]> {
  // Resolve DexScreener pair address from Meteora pool address
  let dexPairAddress: string;
  try {
    dexPairAddress = await resolveDexScreenerPairAddress(poolAddress);
  } catch (err) {
    log("WARN", "DexScreener pair lookup failed, trying Meteora OHLCV", {
      error: err instanceof Error ? err.message : String(err),
    });
    const fallback = await fetchMeteoraCandles(poolAddress, limit);
    if (fallback.length < 60) {
      throw new Error(
        `Insufficient candles: got ${fallback.length}, need at least 60`
      );
    }
    return fallback;
  }

  // Try DexScreener chart with resolved pair address
  try {
    const candles = await fetchDexScreenerCandles(dexPairAddress, limit);
    if (candles.length < 60) {
      throw new Error(
        `Insufficient candles from DexScreener: got ${candles.length}, need at least 60`
      );
    }
    return candles;
  } catch (err) {
    log("WARN", "DexScreener chart failed, trying Meteora OHLCV", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Fallback: Meteora OHLCV (1m → aggregate to 15m)
  const fallback = await fetchMeteoraCandles(poolAddress, limit);
  if (fallback.length < 60) {
    throw new Error(
      `Insufficient candles: got ${fallback.length}, need at least 60`
    );
  }
  return fallback;
}


