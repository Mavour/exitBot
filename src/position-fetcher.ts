import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import { log, logError } from "./logger";
import { withRpcFallback } from "./rpc-manager";

export interface PNLData {
  depositValueSol: number;
  currentValueSol: number;
  totalFeeEarnedSol: number;
  pnlSol: number;
  pnlPercent: number;
}

export interface ActivePosition {
  poolAddress: PublicKey;
  positionPubkey: PublicKey;
  dlmmPool: DLMM;
  baseTokenMint: string;
  quoteTokenMint: string;
  tokenMint: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  isOORRight: boolean;
  isOORLeft: boolean;
  isInRange: boolean;
  totalXAmount: string;
  totalYAmount: string;
  unclaimedFeesX: string;
  unclaimedFeesY: string;
  binRange: { fromBinId: number; toBinId: number };
  binPriceRange: { minPrice: number; maxPrice: number };
  pnl: PNLData | null;
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let tokenSymbolCache: Record<string, string> | null = null;

async function getTokenSymbol(mint: string): Promise<string> {
  if (mint === SOL_MINT) return "SOL";
  if (mint === USDC_MINT) return "USDC";

  if (!tokenSymbolCache) {
    try {
      const res = await fetch("https://token.jup.ag/all", {
        signal: AbortSignal.timeout(10000),
      });
      const data = (await res.json()) as Array<{ address: string; symbol: string }>;
      tokenSymbolCache = {};
      for (const t of data) {
        tokenSymbolCache[t.address] = t.symbol;
      }
    } catch {
      tokenSymbolCache = {};
    }
  }

  return tokenSymbolCache[mint] || mint.slice(0, 6) + "...";
}

async function fetchPositionPriceRanges(
  poolAddress: string,
  walletAddress: string
): Promise<Map<string, { minPrice: number; maxPrice: number }>> {
  const map = new Map<string, { minPrice: number; maxPrice: number }>();
  try {
    const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?status=open&user=${walletAddress}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return map;
    const data = await res.json() as any;
    const positions = data?.positions;
    if (!Array.isArray(positions)) return map;
    for (const p of positions) {
      const addr = p.positionAddress as string;
      const min = Number(p.minPrice);
      const max = Number(p.maxPrice);
      if (addr && Number.isFinite(min) && Number.isFinite(max)) {
        map.set(addr, { minPrice: min, maxPrice: max });
      }
    }
  } catch {
    // Non-critical; fallback handled below
  }
  return map;
}

function parsePNL(
  poolData: Record<string, unknown>
): PNLData | null {
  try {
    const depositStr = (poolData as any).deposit_value ?? (poolData as any).depositValue;
    const currentStr = (poolData as any).current_value ?? (poolData as any).currentValue;
    const feeStr = (poolData as any).total_fee_usd ?? (poolData as any).totalFeeUsd;

    if (depositStr == null || currentStr == null) return null;

    const depositUsd = Number(depositStr);
    const currentUsd = Number(currentStr);
    const feeUsd = feeStr != null ? Number(feeStr) : 0;
    if (!Number.isFinite(depositUsd) || !Number.isFinite(currentUsd)) return null;

    // Approximate SOL price as 1:1 for USD-denominated values from API
    // If API returns USD values, we treat them as SOL-equivalent
    const depositValueSol = depositUsd;
    const currentValueSol = currentUsd;
    const totalFeeEarnedSol = feeUsd;
    const pnlSol = currentValueSol + totalFeeEarnedSol - depositValueSol;
    const pnlPercent = depositValueSol > 0 ? (pnlSol / depositValueSol) * 100 : 0;

    return { depositValueSol, currentValueSol, totalFeeEarnedSol, pnlSol, pnlPercent };
  } catch {
    return null;
  }
}

export async function fetchAllActivePositions(
  wallet: PublicKey,
  connection: Connection
): Promise<ActivePosition[]> {
  const walletAddress = wallet.toBase58();
  const url = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;

  log("INFO", "Fetching positions from Meteora Data API", { url });

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    logError("Failed to fetch positions from Meteora Data API", err);
    return [];
  }

  if (!response.ok) {
    log("ERROR", `Meteora Data API returned ${response.status}`);
    return [];
  }

  let data: any;
  try {
    data = await response.json();
  } catch (err) {
    logError("Failed to parse Meteora Data API response", err);
    return [];
  }

  if (!data.pools || data.pools.length === 0) {
    log("INFO", "No open positions found in wallet");
    return [];
  }

  log("INFO", `Found ${data.totalPositions} positions across ${data.pools.length} pools`);

  const positions: ActivePosition[] = [];

  for (const pool of data.pools) {
    if (!pool.listPositions || pool.listPositions.length === 0) continue;

    const poolPubkey = new PublicKey(pool.poolAddress);

    let dlmmPool: DLMM;
    try {
      dlmmPool = await withRpcFallback(conn =>
        DLMM.create(conn, poolPubkey, { cluster: "mainnet-beta" })
      );
    } catch (err) {
      logError(`Failed to create DLMM instance for pool ${pool.poolAddress}`, err);
      continue;
    }

    let positionsByUser;
    try {
      positionsByUser = await withRpcFallback(conn =>
        dlmmPool.getPositionsByUserAndLbPair(wallet)
      );
    } catch (err) {
      logError(`Failed to fetch positions for pool ${pool.poolAddress}`, err);
      continue;
    }

    const baseSymbol = await getTokenSymbol(pool.tokenXMint);
    const quoteSymbol = await getTokenSymbol(pool.tokenYMint);

    // Fetch price ranges from Meteora PNL API (eliminates SDK bin→price conversion)
    const priceRangeMap = await fetchPositionPriceRanges(pool.poolAddress, walletAddress);

    for (const posAddrStr of pool.listPositions) {
      const posPubkey = new PublicKey(posAddrStr);

      const posData = positionsByUser.userPositions.find(
        (up) => up.publicKey.toBase58() === posAddrStr
      );

      if (!posData) {
        log("WARN", `Position ${posAddrStr} not found on-chain, skipping`);
        continue;
      }

      const posInfo = posData.positionData;

      if (posInfo.totalXAmount === "0" && posInfo.totalYAmount === "0") {
        log("INFO", `Skipping empty position ${posAddrStr}`);
        continue;
      }

      const fromBinId = posInfo.lowerBinId;
      const toBinId = posInfo.upperBinId;

      // Price range sourced from Meteora PNL API (no SDK bin→price conversion)
      const priceRange = priceRangeMap.get(posAddrStr);
      if (!priceRange) {
        log("WARN", "No price range from API, skipping position", { positionAddress: posAddrStr });
        continue;
      }

      log("INFO", "Position price range", {
        positionAddress: posAddrStr,
        minPrice: priceRange.minPrice,
        maxPrice: priceRange.maxPrice,
        fromBinId,
        toBinId,
      });

      positions.push({
        poolAddress: poolPubkey,
        positionPubkey: posPubkey,
        dlmmPool,
        baseTokenMint: pool.tokenXMint,
        quoteTokenMint: pool.tokenYMint,
        tokenMint: pool.tokenXMint,
        tokenXSymbol: baseSymbol,
        tokenYSymbol: quoteSymbol,
        isOORRight: false,
        isOORLeft: false,
        isInRange: true,
        totalXAmount: posInfo.totalXAmount,
        totalYAmount: posInfo.totalYAmount,
        unclaimedFeesX: posInfo.feeX.toString(),
        unclaimedFeesY: posInfo.feeY.toString(),
        binRange: {
          fromBinId: posInfo.lowerBinId,
          toBinId: posInfo.upperBinId,
        },
        binPriceRange: { minPrice: priceRange.minPrice, maxPrice: priceRange.maxPrice },
        pnl: parsePNL(pool),
      });
    }
  }

  log("INFO", `Loaded ${positions.length} active positions`);
  return positions;
}
