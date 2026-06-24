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

type JupiterApi = {
  name: string;
  baseUrl: string;
  requiresApiKey: boolean;
};

const JUPITER_APIS: JupiterApi[] = [
  {
    name: "Jupiter Pro",
    baseUrl: "https://api.jup.ag/swap/v1",
    requiresApiKey: true,
  },
  {
    name: "Jupiter Lite",
    baseUrl: "https://lite-api.jup.ag/swap/v1",
    requiresApiKey: false,
  },
  {
    name: "Jupiter Legacy",
    baseUrl: "https://quote-api.jup.ag/v6",
    requiresApiKey: false,
  },
];
const JUPITER_ULTRA_API = "https://api.jup.ag/ultra/v1";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface SwapResult {
  success: boolean;
  inputMint?: string;
  inputSymbol: string;
  inputAmount: string;
  outputAmount: string;
  txSignature?: string;
  reason?: string;
}

let tokenDecimalsCache: Record<string, number> | null = null;

function getJupiterApis(): JupiterApi[] {
  if (CONFIG.jupiterApiKey) return JUPITER_APIS;
  return JUPITER_APIS.filter((api) => !api.requiresApiKey);
}

function getJupiterHeaders(contentTypeJson = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentTypeJson) headers["Content-Type"] = "application/json";
  if (CONFIG.jupiterApiKey) headers["x-api-key"] = CONFIG.jupiterApiKey;
  return headers;
}

async function readErrorBody(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return body ? `: ${body.slice(0, 180)}` : "";
}

async function fetchJupiterQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
}): Promise<{ quote: any; api: JupiterApi }> {
  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount.toString(),
    slippageBps: String(params.slippageBps),
    restrictIntermediateTokens: "true",
    instructionVersion: "V2",
  });
  let lastErr = "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const api of getJupiterApis()) {
      try {
        const res = await fetch(`${api.baseUrl}/quote?${qs.toString()}`, {
          headers: getJupiterHeaders(),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          lastErr = `${api.name} quote HTTP ${res.status}${await readErrorBody(res)}`;
          continue;
        }
        const quote = (await res.json()) as any;
        if (quote?.error) {
          lastErr = `${api.name} quote error: ${quote.error}`;
          continue;
        }
        return { quote, api };
      } catch (err) {
        lastErr = `${api.name} quote failed: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }

    if (attempt < 3) {
      const delayMs = 1500 * attempt;
      log("WARN", `Jupiter quote attempt ${attempt}/3 failed, retrying`, {
        error: lastErr,
        delayMs,
      });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw new Error(lastErr || "Jupiter quote unavailable");
}

async function fetchJupiterSwapTransaction(
  api: JupiterApi,
  quote: any,
  userPublicKey: string
): Promise<string> {
  let lastErr = "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${api.baseUrl}/swap`, {
        method: "POST",
        headers: getJupiterHeaders(true),
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        lastErr = `${api.name} swap HTTP ${res.status}${await readErrorBody(res)}`;
      } else {
        const swapData = (await res.json()) as {
          swapTransaction?: string;
          error?: string;
        };
        if (swapData.error) {
          lastErr = `${api.name} swap error: ${swapData.error}`;
        } else if (swapData.swapTransaction) {
          return swapData.swapTransaction;
        } else {
          lastErr = `${api.name} swap response missing transaction`;
        }
      }
    } catch (err) {
      lastErr = `${api.name} swap failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }

    if (attempt < 3) {
      const delayMs = 1500 * attempt;
      log("WARN", `Jupiter swap build attempt ${attempt}/3 failed, retrying`, {
        api: api.name,
        error: lastErr,
        delayMs,
      });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw new Error(lastErr || "Jupiter swap endpoint unavailable");
}

async function executeJupiterUltraSwap(params: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  wallet: Keypair;
}): Promise<{ signature: string; outputAmount?: string }> {
  if (!CONFIG.jupiterApiKey) {
    throw new Error("JUPITER_API_KEY not configured");
  }

  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount.toString(),
    taker: params.wallet.publicKey.toBase58(),
  });
  let lastErr = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const orderRes = await fetch(`${JUPITER_ULTRA_API}/order?${qs.toString()}`, {
        headers: getJupiterHeaders(),
        signal: AbortSignal.timeout(12000),
      });
      if (!orderRes.ok) {
        lastErr = `Jupiter Ultra order HTTP ${orderRes.status}${await readErrorBody(orderRes)}`;
        throw new Error(lastErr);
      }

      const order = (await orderRes.json()) as {
        transaction?: string;
        requestId?: string;
        errorCode?: string;
        errorMessage?: string;
      };
      if (order.errorCode || order.errorMessage) {
        lastErr = `Jupiter Ultra order error: ${order.errorCode || ""} ${order.errorMessage || ""}`.trim();
        throw new Error(lastErr);
      }
      if (!order.transaction || !order.requestId) {
        lastErr = "Jupiter Ultra order response missing transaction/requestId";
        throw new Error(lastErr);
      }

      const tx = VersionedTransaction.deserialize(
        Buffer.from(order.transaction, "base64")
      );
      tx.sign([params.wallet]);
      const signedTransaction = Buffer.from(tx.serialize()).toString("base64");

      const executeRes = await fetch(`${JUPITER_ULTRA_API}/execute`, {
        method: "POST",
        headers: getJupiterHeaders(true),
        body: JSON.stringify({
          signedTransaction,
          requestId: order.requestId,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!executeRes.ok) {
        lastErr = `Jupiter Ultra execute HTTP ${executeRes.status}${await readErrorBody(executeRes)}`;
        throw new Error(lastErr);
      }

      const executed = (await executeRes.json()) as {
        status?: string;
        signature?: string;
        outputAmountResult?: string;
        code?: string;
        error?: string;
      };
      if (executed.status === "Failed" || executed.error) {
        lastErr = `Jupiter Ultra execute failed: ${executed.code || executed.error || "unknown"}`;
        throw new Error(lastErr);
      }
      if (!executed.signature) {
        lastErr = "Jupiter Ultra execute response missing signature";
        throw new Error(lastErr);
      }

      return {
        signature: executed.signature,
        outputAmount: executed.outputAmountResult,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (attempt < 2) {
        const delayMs = 1500 * attempt;
        log("WARN", `Jupiter Ultra attempt ${attempt}/2 failed, retrying`, {
          error: lastErr,
          delayMs,
        });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  throw new Error(lastErr || "Jupiter Ultra unavailable");
}

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
    inputMint: params.receivedTokenMint,
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

  if (!params.dryRun && CONFIG.jupiterApiKey) {
    try {
      const ultra = await executeJupiterUltraSwap({
        inputMint: params.receivedTokenMint,
        outputMint: SOL_MINT,
        amount: rawAmount,
        wallet: params.wallet,
      });
      const ultraOutAmount = ultra.outputAmount
        ? Number(ultra.outputAmount) / 10 ** 9
        : 0;
      if (ultraOutAmount > 0) {
        result.outputAmount = ultraOutAmount.toFixed(6);
      }
      result.success = true;
      result.txSignature = ultra.signature;
      result.reason = "Jupiter Ultra swap executed";
      log("EXIT", "Auto-swap confirmed via Jupiter Ultra", {
        signature: ultra.signature,
        input: `${result.inputAmount} ${params.receivedTokenSymbol}`,
        output: result.outputAmount,
      });
      return result;
    } catch (err) {
      log("WARN", "Jupiter Ultra auto-swap failed, falling back to Swap API", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Get Jupiter quote
  let quote: any;
  let quoteApi: JupiterApi;
  try {
    const quoted = await fetchJupiterQuote({
      inputMint: params.receivedTokenMint,
      outputMint: SOL_MINT,
      amount: rawAmount,
      slippageBps: CONFIG.slippageBps,
    });
    quote = quoted.quote;
    quoteApi = quoted.api;
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
    const swapTransaction = await fetchJupiterSwapTransaction(
      quoteApi,
      quote,
      params.wallet.publicKey.toBase58()
    );
    const tx = VersionedTransaction.deserialize(
      Buffer.from(swapTransaction, "base64")
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
