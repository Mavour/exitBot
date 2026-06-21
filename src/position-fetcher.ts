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

interface MeteoraPositionResponse {
  positions: Array<{
    position: {
      address: string;
    };
    pool: {
      address: string;
      pair_type: string;
      token_x_mint: string;
      token_y_mint: string;
    };
  }>;
}

export async function fetchAllActivePositions(
  wallet: PublicKey,
  connection: Connection
): Promise<ActivePosition[]> {
  const walletAddress = wallet.toBase58();
  const url = `https://dlmm-api.meteora.ag/position/${walletAddress}`;

  log("INFO", "Fetching positions from Meteora API", { url });

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    logError("Failed to fetch positions from Meteora API", err);
    return [];
  }

  if (!response.ok) {
    log("ERROR", `Meteora API returned ${response.status}`);
    return [];
  }

  let data: MeteoraPositionResponse;
  try {
    data = (await response.json()) as MeteoraPositionResponse;
  } catch (err) {
    logError("Failed to parse Meteora API response", err);
    return [];
  }

  if (!data.positions || data.positions.length === 0) {
    log("INFO", "No positions found in wallet");
    return [];
  }

  log("INFO", `Found ${data.positions.length} positions via API`);

  const positions: ActivePosition[] = [];
  const poolCache = new Map<string, DLMM>();

  for (const p of data.positions) {
    const poolAddrStr = p.pool.address;
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

    const positionPubkey = new PublicKey(p.position.address);

    let positionsByUser;
    try {
      positionsByUser = await dlmmPool.getPositionsByUserAndLbPair(
        wallet
      );
    } catch (err) {
      logError(
        `Failed to fetch position data for ${p.position.address}`,
        err
      );
      continue;
    }

    const posData = positionsByUser.userPositions.find(
      (up) => up.publicKey.toBase58() === p.position.address
    );

    if (!posData) {
      log("WARN", `Position ${p.position.address} not found on-chain, skipping`);
      continue;
    }

    const posInfo = posData.positionData;

    // Skip positions with zero liquidity
    if (posInfo.totalXAmount === "0" && posInfo.totalYAmount === "0") {
      log("INFO", `Skipping empty position ${p.position.address}`);
      continue;
    }

    const activePosition: ActivePosition = {
      poolAddress: poolPubkey,
      positionPubkey,
      dlmmPool,
      baseTokenMint: p.pool.token_x_mint,
      quoteTokenMint: p.pool.token_y_mint,
      dexScreenerPairAddress: "",
      totalXAmount: posInfo.totalXAmount,
      totalYAmount: posInfo.totalYAmount,
      unclaimedFeesX: posInfo.feeX.toString(),
      unclaimedFeesY: posInfo.feeY.toString(),
      binRange: {
        fromBinId: posInfo.lowerBinId,
        toBinId: posInfo.upperBinId,
      },
    };

    positions.push(activePosition);
  }

  log("INFO", `Loaded ${positions.length} active positions`);
  return positions;
}
