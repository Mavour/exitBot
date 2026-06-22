import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import { log, logError } from "./logger";

export interface ActivePosition {
  poolAddress: PublicKey;
  positionPubkey: PublicKey;
  dlmmPool: DLMM;
  baseTokenMint: string;
  quoteTokenMint: string;
  tokenMint: string;
  totalXAmount: string;
  totalYAmount: string;
  unclaimedFeesX: string;
  unclaimedFeesY: string;
  binRange: { fromBinId: number; toBinId: number };
}

interface ApiPoolItem {
  poolAddress: string;
  tokenXMint: string;
  tokenYMint: string;
  listPositions: string[];
}

interface ApiPortfolioResponse {
  totalPositions: number;
  pools: ApiPoolItem[];
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

  let data: ApiPortfolioResponse;
  try {
    data = (await response.json()) as ApiPortfolioResponse;
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
      dlmmPool = await DLMM.create(connection, poolPubkey, {
        cluster: "mainnet-beta",
      });
    } catch (err) {
      logError(`Failed to create DLMM instance for pool ${pool.poolAddress}`, err);
      continue;
    }

    let positionsByUser;
    try {
      positionsByUser = await dlmmPool.getPositionsByUserAndLbPair(wallet);
    } catch (err) {
      logError(`Failed to fetch positions for pool ${pool.poolAddress}`, err);
      continue;
    }

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

      positions.push({
        poolAddress: poolPubkey,
        positionPubkey: posPubkey,
        dlmmPool,
        baseTokenMint: pool.tokenXMint,
        quoteTokenMint: pool.tokenYMint,
        tokenMint: pool.tokenXMint,
        totalXAmount: posInfo.totalXAmount,
        totalYAmount: posInfo.totalYAmount,
        unclaimedFeesX: posInfo.feeX.toString(),
        unclaimedFeesY: posInfo.feeY.toString(),
        binRange: {
          fromBinId: posInfo.lowerBinId,
          toBinId: posInfo.upperBinId,
        },
      });
    }
  }

  log("INFO", `Loaded ${positions.length} active positions`);
  return positions;
}
