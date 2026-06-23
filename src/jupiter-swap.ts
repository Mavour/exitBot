import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { CONFIG } from "./config";
import { log, logError } from "./logger";
import { withRpcFallback } from "./rpc-manager";

const JUPITER_API = "https://quote-api.jup.ag/v6";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface SwapResult {
  success: boolean;
  inputSymbol: string;
  inputAmount: string;
  outputAmount: string;
  txSignature?: string;
  reason?: string;
}

let tokenDecimalsCache: Record<string, number> | null = null;

async function getTokenDecimals(
  mint: string,
  connection: Connection
): Promise<number> {
  if (mint === SOL_MINT) return 9;
  if (mint === USDC_MINT) return 6;

  // Try Jupiter token list first (avoids RPC 429)
  if (!tokenDecimalsCache) {
    try {
      const res = await fetch("https://token.jup.ag/all", {
        signal: AbortSignal.timeout(10000),
      });
      const data = (await res.json()) as Array<{ address: string; symbol: string; decimals: number }>;
      tokenDecimalsCache = {};
      for (const t of data) {
        tokenDecimalsCache[t.address] = t.decimals;
      }
    } catch {
      throw new Error(`Failed to fetch Jupiter token list for decimals lookup`);
    }
  }
  if (tokenDecimalsCache[mint] !== undefined) {
    return tokenDecimalsCache[mint];
  }

  // Fallback: try RPC with retry on 429
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const mintPubkey = new PublicKey(mint);
      const info = await withRpcFallback(conn => getMint(conn, mintPubkey));
      return info.decimals;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt === 0) {
        log("WARN", "RPC getMint failed, retrying after 2s", { mint });
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  throw lastErr || new Error(`Failed to fetch decimals for ${mint}`);
}

async function getTokenValueUsd(
  mint: string,
  rawAmount: string,
  decimals: number
): Promise<number> {
  const humanAmount = Number(rawAmount) / Math.pow(10, decimals);
  if (!Number.isFinite(humanAmount) || humanAmount <= 0) return 0;

  const jupiterPrice = await fetchJupiterPrice(mint);
  if (jupiterPrice !== null) {
    return humanAmount * jupiterPrice;
  }

  const dexPrice = await fetchDexScreenerPrice(mint);
  if (dexPrice !== null) {
    return humanAmount * dexPrice;
  }

  return 0;
}

async function fetchJupiterPrice(mint: string): Promise<number | null> {
  try {
    const url = `https://api.jup.ag/price/v2?ids=${mint}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const entry = json?.data?.[mint];
    const price = entry?.price;
    return typeof price === "number" && price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function fetchDexScreenerPrice(mint: string): Promise<number | null> {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
    const solanaPair = pairs
      .filter((p: any) => p?.chainId === "solana")
      .sort((a: any, b: any) => {
        const la = Number(a?.liquidity?.usd ?? a?.liquidityUsd ?? 0);
        const lb = Number(b?.liquidity?.usd ?? b?.liquidityUsd ?? 0);
        return lb - la;
      })[0];
    if (!solanaPair) return null;
    const price = Number(solanaPair.priceUsd);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

export async function autoSwapAfterExit(params: {
  receivedTokenMint: string;
  receivedTokenSymbol: string;
  receivedAmount: string;
  wallet: Keypair;
  connection: Connection;
  dryRun: boolean;
  tokenDecimals?: number;
}): Promise<SwapResult> {
  const result: SwapResult = {
    success: false,
    inputSymbol: params.receivedTokenSymbol,
    inputAmount: params.receivedAmount,
    outputAmount: "0",
    reason: "",
  };

  // Skip if token is SOL or USDC
  if (
    params.receivedTokenMint === SOL_MINT ||
    params.receivedTokenMint === USDC_MINT
  ) {
    result.success = true;
    result.reason = `${params.receivedTokenSymbol} is SOL/USDC, no swap needed`;
    return result;
  }

  // Get token decimals — use pool metadata if provided, otherwise fallback to lookup
  let decimals: number;
  if (params.tokenDecimals !== undefined) {
    decimals = params.tokenDecimals;
  } else {
    try {
      decimals = await getTokenDecimals(params.receivedTokenMint, params.connection);
    } catch (err) {
      result.reason = `Failed to get token decimals: ${err instanceof Error ? err.message : String(err)}`;
      return result;
    }
  }

  // Re-fetch actual token balance from wallet after exit
  let rawAmount: bigint;
  try {
    const tokenAccounts = await withRpcFallback(conn =>
      conn.getParsedTokenAccountsByOwner(params.wallet.publicKey, {
        mint: new PublicKey(params.receivedTokenMint),
      })
    );
    const balance = tokenAccounts.value[0]?.account.data.parsed.info.tokenAmount;
    if (!balance || balance.amount === "0") {
      result.reason = `No ${params.receivedTokenSymbol} balance in wallet after exit`;
      return result;
    }
    rawAmount = BigInt(balance.amount);
    decimals = balance.decimals;
    result.inputAmount = (Number(rawAmount) / Math.pow(10, decimals)).toFixed(decimals);
  } catch (err) {
    result.reason = `Failed to fetch token balance: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }

  // Check minimum value — only block swap if we KNOW the value is below threshold.
  // If USD value is unknown (0 from no price available), skip cleanly without failing exit.
  const usdValue = await getTokenValueUsd(
    params.receivedTokenMint,
    rawAmount.toString(),
    decimals
  );
  if (usdValue > 0 && usdValue < CONFIG.autoSwapMinUsd) {
    result.reason = `${params.receivedTokenSymbol} value $${usdValue.toFixed(3)} below $${CONFIG.autoSwapMinUsd.toFixed(2)} minimum`;
    return result;
  }
  if (usdValue === 0) {
    result.reason = `no USD price available for ${params.receivedTokenSymbol}, swap skipped`;
    log("WARN", result.reason, {
      mint: params.receivedTokenMint,
      rawAmount: rawAmount.toString(),
    });
    return result;
  }

  // Get Jupiter quote
  let quote: any;
  try {
    const quoteUrl = `${JUPITER_API}/quote?inputMint=${params.receivedTokenMint}&outputMint=${SOL_MINT}&amount=${rawAmount}&slippageBps=${CONFIG.slippageBps}`;
    const res = await fetch(quoteUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      result.reason = "Jupiter quote unavailable";
      return result;
    }
    quote = await res.json();
    if (quote.error) {
      result.reason = `Jupiter quote error: ${quote.error}`;
      return result;
    }
  } catch (err) {
    result.reason = `Jupiter quote failed: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }

  const outAmount = parseFloat(quote.outAmount) / 10 ** 9;
  result.outputAmount = outAmount.toFixed(6);

  if (params.dryRun) {
    result.success = true;
    result.reason = "DRY RUN — swap simulated";
    return result;
  }

  // Execute swap
  try {
    const swapRes = await fetch(`${JUPITER_API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: params.wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!swapRes.ok) {
      result.reason = "Jupiter swap endpoint error";
      return result;
    }

    const swapData = (await swapRes.json()) as { swapTransaction: string };
    const tx = VersionedTransaction.deserialize(
      Buffer.from(swapData.swapTransaction, "base64")
    );
    tx.sign([params.wallet]);

    const sig = await withRpcFallback(conn => conn.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 2,
    }));

    await withRpcFallback(conn => conn.confirmTransaction(sig, CONFIG.commitment));

    result.success = true;
    result.txSignature = sig;
    log("EXIT", "Auto-swap confirmed", {
      signature: sig,
      input: `${params.receivedAmount} ${params.receivedTokenSymbol}`,
      output: `${result.outputAmount} SOL`,
    });
  } catch (err) {
    result.reason = `Swap execution failed: ${err instanceof Error ? err.message : String(err)}`;
    logError("Auto-swap failed", err);
  }

  return result;
}
