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
  txns: Record<string, unknown>;
  volume: Record<string, unknown>;
  priceChange: Record<string, unknown>;
  liquidity: Record<string, unknown>;
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

  // Take only last `limit` candles and sort oldest → newest
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
  baseTokenMint: string,
  quoteTokenMint: string
): Promise<string> {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${baseTokenMint}`;

  const response = await fetchWithRetry(url);
  const data = (await response.json()) as DexScreenerSearchResponse;

  if (!data.pairs || data.pairs.length === 0) {
    throw new Error(`No DexScreener pairs found for token ${baseTokenMint}`);
  }

  // Find a Solana Meteora pair matching both mints
  for (const pair of data.pairs) {
    if (pair.chainId !== "solana") continue;
    if (
      pair.baseToken.address.toLowerCase() === baseTokenMint.toLowerCase() &&
      pair.quoteToken.address.toLowerCase() === quoteTokenMint.toLowerCase()
    ) {
      log("INFO", `Found DexScreener pair`, {
        pairAddress: pair.pairAddress,
        baseSymbol: pair.baseToken.symbol,
        quoteSymbol: pair.quoteToken.symbol,
      });
      return pair.pairAddress;
    }
  }

  // Fallback: return first Solana pair
  const solanaPair = data.pairs.find((p) => p.chainId === "solana");
  if (solanaPair) {
    log("WARN", "Using fallback DexScreener pair (exact mint match not found)", {
      pairAddress: solanaPair.pairAddress,
    });
    return solanaPair.pairAddress;
  }

  throw new Error(
    `No Solana DexScreener pair found for token ${baseTokenMint}`
  );
}
