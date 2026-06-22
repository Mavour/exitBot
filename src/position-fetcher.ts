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

function parsePNL(
  poolData: Record<string, unknown>
): PNLData | null {
  try {
    const pnlSolStr = (poolData as any).pnlSol;
    const pnlPctStr = (poolData as any).pnlPctChange;
    const feeStr = (poolData as any).unclaimedFeesSol;
    const depositStr = (poolData as any).totalDepositSol;
    const balanceStr = (poolData as any).balancesSol;

    if (pnlSolStr == null) return null;

    const pnlSol = Number(pnlSolStr);
    const pnlPercent = pnlPctStr != null ? Number(pnlPctStr) : 0;
    const totalFeeEarnedSol = feeStr != null ? Number(feeStr) : 0;
    const depositValueSol = depositStr != null ? Number(depositStr) : 0;
    const currentValueSol = balanceStr != null ? Number(balanceStr) : 0;

    if (!Number.isFinite(pnlSol)) return null;

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
    const poolPrice = Number(pool.poolPrice);

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

      // OOR detection — use API fields directly
      const isOutOfRange = pool.outOfRange === true ||
        (Array.isArray(pool.positionsOutOfRange) && pool.positionsOutOfRange.includes(posAddrStr));

      // Determine OOR direction using bin price data from SDK position data
      const posAny = posData as any;
      const lowerBinPrice = Number(posAny.lowerBinArray?.bins?.[0]?.price ?? 0);
      const upperBinPrice = Number(posAny.upperBinArray?.bins?.slice(-1)?.[0]?.price ?? 0);
      const midPrice = (lowerBinPrice + upperBinPrice) / 2;

      let isOORRight = false;
      let isOORLeft = false;
      let isInRange = true;

      if (isOutOfRange) {
        if (Number.isFinite(poolPrice) && Number.isFinite(midPrice)) {
          if (poolPrice > midPrice) {
            isOORRight = true;
            isInRange = false;
          } else {
            isOORLeft = true;
            isInRange = false;
          }
        }
      }

      log("INFO", "OOR status", {
        positionAddress: posAddrStr,
        isInRange,
        isOORLeft,
        isOORRight,
        poolPrice,
        fromBinId: posInfo.lowerBinId,
        toBinId: posInfo.upperBinId,
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
        isOORRight,
        isOORLeft,
        isInRange,
        totalXAmount: posInfo.totalXAmount,
        totalYAmount: posInfo.totalYAmount,
        unclaimedFeesX: posInfo.feeX.toString(),
        unclaimedFeesY: posInfo.feeY.toString(),
        binRange: {
          fromBinId: posInfo.lowerBinId,
          toBinId: posInfo.upperBinId,
        },
        pnl: parsePNL(pool),
      });
    }
  }

  log("INFO", `Loaded ${positions.length} active positions`);
  return positions;
}
