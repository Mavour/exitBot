import { log, logError } from "./logger";

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

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  txns: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  priceChange: Record<string, unknown>;
  liquidity: { usd: number };
  fdv: number;
  marketCap: number;
  pairCreatedAt: number;
  info: Record<string, unknown>;
}

interface DexScreenerSearchResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[] | null;
}

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

export async function getCandles15m(
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

  const candles: Candle[] = slices.map((entry) => ({
    timestamp: entry.timestamp,
    open: parseFloat(entry.open),
    high: parseFloat(entry.high),
    low: parseFloat(entry.low),
    close: parseFloat(entry.close),
    volume: parseFloat(entry.volume),
  }));

  return candles;
}

export async function getDexScreenerPairFromMints(
  baseTokenMint: string
): Promise<string> {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${baseTokenMint}`;

  const response = await fetchWithRetry(url);
  const data = (await response.json()) as DexScreenerSearchResponse;

  if (!data.pairs || data.pairs.length === 0) {
    throw new Error(`No DexScreener pairs found for token ${baseTokenMint}`);
  }

  // Filter: Solana chain + Meteora dex
  const meteoraPairs = data.pairs.filter(
    (p) => p.chainId === "solana" && p.dexId === "meteora"
  );

  if (meteoraPairs.length === 0) {
    // Fallback: use first Solana pair regardless of dex
    const solFallback = data.pairs.find((p) => p.chainId === "solana");
    if (solFallback) {
      log("WARN", "No Meteora pair found, using first Solana pair as fallback", {
        pairAddress: solFallback.pairAddress,
        dexId: solFallback.dexId,
      });
      return solFallback.pairAddress;
    }
    throw new Error(`No Solana pairs found for token ${baseTokenMint}`);
  }

  // Pick the pair with highest 24h tx count
  meteoraPairs.sort((a, b) => (b.txns?.h24 ?? 0) - (a.txns?.h24 ?? 0));
  const best = meteoraPairs[0];

  log("INFO", `Found DexScreener Meteora pair`, {
    pairAddress: best.pairAddress,
    baseSymbol: best.baseToken.symbol,
    quoteSymbol: best.quoteToken.symbol,
    txns24h: best.txns?.h24 ?? 0,
  });

  return best.pairAddress;
}
