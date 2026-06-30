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
  source?: "rpc" | "meteora_position" | "meteora_pool";
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
  openedAtMs?: number;
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
      return mint.slice(0, 6) + "...";
    }
  }

  return tokenSymbolCache[mint] || mint.slice(0, 6) + "...";
}

async function resolveTokenSymbol(
  mint: string,
  apiSymbol: unknown
): Promise<string> {
  if (typeof apiSymbol === "string") {
    const trimmed = apiSymbol.trim();
    const looksLikeMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
    if (trimmed && !looksLikeMint) return trimmed;
  }
  return getTokenSymbol(mint);
}

function parsePNL(
  poolData: Record<string, unknown>
): PNLData | null {
  try {
    const pnlSolStr = (poolData as any).pnlSol;
    const pnlPctStr = (poolData as any).pnlSolPctChange;
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

    return { depositValueSol, currentValueSol, totalFeeEarnedSol, pnlSol, pnlPercent, source: "meteora_pool" };
  } catch {
    return null;
  }
}

function pnlNumber(value: unknown, fallback = 0): number {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = Number.parseFloat(String(value ?? ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function calculatePnl({
  balance,
  withdrawals,
  claimableFees,
  claimedFees,
  deposits,
}: {
  balance: unknown;
  withdrawals: unknown;
  claimableFees: unknown;
  claimedFees: unknown;
  deposits: unknown;
}): { deposits: number; balance: number; claimableFees: number; claimedFees: number; pnl: number; pnlPct: number | null } {
  const normalized = {
    balance: pnlNumber(balance),
    withdrawals: pnlNumber(withdrawals),
    claimableFees: pnlNumber(claimableFees),
    claimedFees: pnlNumber(claimedFees),
    deposits: pnlNumber(deposits),
  };
  const pnl =
    normalized.balance +
    normalized.withdrawals +
    normalized.claimableFees +
    normalized.claimedFees -
    normalized.deposits;

  return {
    ...normalized,
    pnl,
    pnlPct: normalized.deposits > 0 ? (pnl / normalized.deposits) * 100 : null,
  };
}

function readPath(data: any, path: string): unknown {
  return path.split(".").reduce((current, key) => current?.[key], data);
}

async function fetchPositionPnlRows(
  poolAddress: string,
  walletAddress: string
): Promise<Map<string, Record<string, any>>> {
  const url =
    `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl` +
    `?user=${walletAddress}&status=open&pageSize=100&page=1`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("WARN", "Meteora position PNL API returned non-OK", {
        poolAddress,
        status: res.status,
        body: body.slice(0, 160),
      });
      return new Map();
    }

    const data = await res.json() as any;
    const rows = data?.positions ?? data?.data;
    if (!Array.isArray(rows)) return new Map();

    const byPosition = new Map<string, Record<string, any>>();
    for (const row of rows) {
      const address = row.positionAddress ?? row.address ?? row.position;
      if (typeof address === "string" && address) {
        byPosition.set(address, row);
      }
    }
    return byPosition;
  } catch (err) {
    log("WARN", "Failed to fetch Meteora position PNL rows", {
      poolAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

function parsePositionRowPNL(row: Record<string, any> | undefined): PNLData | null {
  if (!row) return null;

  const pnlSol = firstFiniteNumber(row.pnlSol);
  const pnlPercent = firstFiniteNumber(row.pnlSolPctChange, row.pnlPctChange, row.pnlPct);
  if (pnlSol === null || pnlPercent === null) return null;

  const claimedFees = pnlNumber(readPath(row, "allTimeFees.total.sol"));
  const unclaimedFees =
    pnlNumber(readPath(row, "unrealizedPnl.unclaimedFeeTokenX.amountSol")) +
    pnlNumber(readPath(row, "unrealizedPnl.unclaimedFeeTokenY.amountSol")) +
    pnlNumber(readPath(row, "unrealizedPnl.unclaimedRewardTokenX.amountSol")) +
    pnlNumber(readPath(row, "unrealizedPnl.unclaimedRewardTokenY.amountSol"));

  return {
    depositValueSol: pnlNumber(readPath(row, "allTimeDeposits.total.sol")),
    currentValueSol: pnlNumber(readPath(row, "unrealizedPnl.balancesSol")),
    totalFeeEarnedSol: claimedFees + unclaimedFees,
    pnlSol,
    pnlPercent,
    source: "meteora_position",
  };
}

function parsePositionOpenedAtMs(row: Record<string, any> | undefined): number | undefined {
  const createdAt = firstFiniteNumber(row?.createdAt);
  if (createdAt === null) return undefined;
  return createdAt > 1_000_000_000_000 ? createdAt : createdAt * 1000;
}

function calculateRpcPNL({
  posInfo,
  dlmmPool,
  tokenXPriceSol,
  costBasis,
}: {
  posInfo: any;
  dlmmPool: DLMM;
  tokenXPriceSol: number | null;
  costBasis: Record<string, any> | undefined;
}): PNLData | null {
  if (!costBasis || tokenXPriceSol === null || !Number.isFinite(tokenXPriceSol)) {
    return null;
  }

  const tokenXDecimals = dlmmPool.tokenX.mint.decimals;
  const tokenYDecimals = dlmmPool.tokenY.mint.decimals;
  const amountX = pnlNumber(posInfo.totalXAmount?.toString()) / (10 ** tokenXDecimals);
  const amountY = pnlNumber(posInfo.totalYAmount?.toString()) / (10 ** tokenYDecimals);
  const feeX = pnlNumber(posInfo.feeX?.toString()) / (10 ** tokenXDecimals);
  const feeY = pnlNumber(posInfo.feeY?.toString()) / (10 ** tokenYDecimals);
  const balanceSol = amountX * tokenXPriceSol + amountY;
  const claimableSol = feeX * tokenXPriceSol + feeY;

  const calculated = calculatePnl({
    balance: balanceSol,
    withdrawals: readPath(costBasis, "allTimeWithdrawals.total.sol"),
    claimableFees: claimableSol,
    claimedFees: readPath(costBasis, "allTimeFees.total.sol"),
    deposits: readPath(costBasis, "allTimeDeposits.total.sol"),
  });

  const pnlPct = calculated.pnlPct;
  if (!Number.isFinite(calculated.pnl) || pnlPct === null || !Number.isFinite(pnlPct)) {
    return null;
  }

  return {
    depositValueSol: calculated.deposits,
    currentValueSol: calculated.balance,
    totalFeeEarnedSol: calculated.claimedFees + calculated.claimableFees,
    pnlSol: calculated.pnl,
    pnlPercent: pnlPct,
    source: "rpc",
  };
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

    let activeBinId: number | null = null;
    let tokenXPriceSol: number | null = null;
    try {
      const activeBin = await withRpcFallback(conn => dlmmPool.getActiveBin());
      activeBinId = activeBin.binId;
      if (pool.tokenYMint === SOL_MINT) {
        tokenXPriceSol = Number(dlmmPool.fromPricePerLamport(Number(activeBin.price)));
      }
    } catch (err) {
      log("WARN", `Failed to get active bin for pool ${pool.poolAddress.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const positionPnlRows = await fetchPositionPnlRows(pool.poolAddress, walletAddress);
    const baseSymbol = await resolveTokenSymbol(pool.tokenXMint, pool.tokenX);
    const quoteSymbol = await resolveTokenSymbol(pool.tokenYMint, pool.tokenY);
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

      // OOR detection — SDK bin comparison is primary (most reliable)
      const lowerBinId = posInfo.lowerBinId;
      const upperBinId = posInfo.upperBinId;
      const binOOR = activeBinId !== null
        ? (activeBinId < lowerBinId || activeBinId > upperBinId)
        : null;

      const apiOOR = pool.outOfRange === true ||
        (Array.isArray(pool.positionsOutOfRange) && pool.positionsOutOfRange.includes(posAddrStr));

      const isOutOfRange = binOOR === true || (binOOR === null && apiOOR);

      let isOORRight = false;
      let isOORLeft = false;
      let isInRange = true;

      if (isOutOfRange) {
        isInRange = false;
        if (activeBinId !== null && activeBinId > upperBinId) {
          isOORRight = true;
        } else if (activeBinId !== null && activeBinId < lowerBinId) {
          isOORLeft = true;
        } else {
          const posAny = posData as any;
          const lowerBinPrice = Number(posAny.lowerBinArray?.bins?.[0]?.price ?? 0);
          const upperBinPrice = Number(posAny.upperBinArray?.bins?.slice(-1)?.[0]?.price ?? 0);
          if (lowerBinPrice > 0 && upperBinPrice > 0 && Number.isFinite(poolPrice)) {
            const midPrice = (lowerBinPrice + upperBinPrice) / 2;
            if (poolPrice > midPrice) isOORRight = true;
            else isOORLeft = true;
          }
        }
      }

      log("INFO", "OOR status", {
        positionAddress: posAddrStr,
        isInRange,
        isOORLeft,
        isOORRight,
        poolPrice,
        activeBinId,
        fromBinId: posInfo.lowerBinId,
        toBinId: posInfo.upperBinId,
        binOOR,
        apiOOR,
      });

      const positionPnlRow = positionPnlRows.get(posAddrStr);
      const pnl =
        calculateRpcPNL({
          posInfo,
          dlmmPool,
          tokenXPriceSol,
          costBasis: positionPnlRow,
        }) ??
        parsePositionRowPNL(positionPnlRow) ??
        parsePNL(pool);

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
        pnl,
        openedAtMs: parsePositionOpenedAtMs(positionPnlRow),
      });
    }
  }

  log("INFO", `Loaded ${positions.length} active positions`);
  return positions;
}
