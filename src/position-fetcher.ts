import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import { CONFIG } from "./config";
import { log, logError } from "./logger";

export interface ActivePosition {
  poolAddress: PublicKey;
  positionPubkey: PublicKey;
  dlmmPool: DLMM;
  baseTokenMint: string;
  quoteTokenMint: string;
  dexScreenerPairAddress: string;
  totalXAmount: string;
  totalYAmount: string;
  unclaimedFeesX: string;
  unclaimedFeesY: string;
  binRange: { fromBinId: number; toBinId: number };
}

interface ApiOpenPosition {
  position_address: string;
  lower_bin_id: number;
  upper_bin_id: number;
}

interface ApiTokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

interface ApiPositionsByPool {
  pool_address: string;
  token_x: ApiTokenInfo;
  token_y: ApiTokenInfo;
  positions: ApiOpenPosition[];
}

interface ApiOpenPositionsResponse {
  total_positions: number;
  total_pools: number;
  data: ApiPositionsByPool[];
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

  let data: ApiOpenPositionsResponse;
  try {
    data = (await response.json()) as ApiOpenPositionsResponse;
  } catch (err) {
    logError("Failed to parse Meteora Data API response", err);
    return [];
  }

  if (!data.data || data.data.length === 0) {
    log("INFO", "No open positions found in wallet");
    return [];
  }

  log("INFO", `Found ${data.total_positions} positions across ${data.total_pools} pools`);

  const positions: ActivePosition[] = [];
  const poolCache = new Map<string, DLMM>();

  for (const pool of data.data) {
    const poolAddrStr = pool.pool_address;
    const poolPubkey = new PublicKey(poolAddrStr);

    let dlmmPool: DLMM;
    if (poolCache.has(poolAddrStr)) {
      dlmmPool = poolCache.get(poolAddrStr)!;
    } else {
      try {
        dlmmPool = await DLMM.create(connection, poolPubkey, {
          cluster: "mainnet-beta",
        });
        poolCache.set(poolAddrStr, dlmmPool);
      } catch (err) {
        logError(`Failed to create DLMM instance for pool ${poolAddrStr}`, err);
        continue;
      }
    }

    // Fetch on-chain positions for this user+pool
    let positionsByUser;
    try {
      positionsByUser = await dlmmPool.getPositionsByUserAndLbPair(wallet);
    } catch (err) {
      logError(`Failed to fetch positions for pool ${poolAddrStr}`, err);
      continue;
    }

    for (const apiPos of pool.positions) {
      const posPubkey = new PublicKey(apiPos.position_address);
      const posKey = apiPos.position_address;

      const posData = positionsByUser.userPositions.find(
        (up) => up.publicKey.toBase58() === posKey
      );

      if (!posData) {
        log("WARN", `Position ${posKey} not found on-chain, skipping`);
        continue;
      }

      const posInfo = posData.positionData;

      if (posInfo.totalXAmount === "0" && posInfo.totalYAmount === "0") {
        log("INFO", `Skipping empty position ${posKey}`);
        continue;
      }

      const baseTokenMint = pool.token_x.address;
      const quoteTokenMint = pool.token_y.address;

      positions.push({
        poolAddress: poolPubkey,
        positionPubkey: posPubkey,
        dlmmPool,
        baseTokenMint,
        quoteTokenMint,
        dexScreenerPairAddress: "",
        totalXAmount: posInfo.totalXAmount,
        totalYAmount: posInfo.totalYAmount,
        unclaimedFeesX: posInfo.feeX.toString(),
        unclaimedFeesY: posInfo.feeY.toString(),
        binRange: {
          fromBinId: apiPos.lower_bin_id,
          toBinId: apiPos.upper_bin_id,
        },
      });
    }
  }

  log("INFO", `Loaded ${positions.length} active positions`);
  return positions;
}
