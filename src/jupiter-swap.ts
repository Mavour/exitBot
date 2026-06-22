import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { CONFIG } from "./config";
import { log, logError } from "./logger";

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

async function getTokenDecimals(
  mint: string,
  connection: Connection
): Promise<number> {
  if (mint === SOL_MINT) return 9;
  if (mint === USDC_MINT) return 6;
  const mintPubkey = new PublicKey(mint);
  const info = await getMint(connection, mintPubkey);
  return info.decimals;
}

function parseHumanAmount(amount: string): number {
  const n = parseFloat(amount);
  return Number.isFinite(n) ? n : 0;
}

async function getTokenValueUsd(
  mint: string,
  humanAmount: number
): Promise<number> {
  try {
    const url = `https://price.jup.ag/v4/price?ids=${mint}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return 0;
    const json = (await res.json()) as any;
    const price = json?.data?.[mint]?.price;
    if (typeof price !== "number") return 0;
    return humanAmount * price;
  } catch {
    return 0;
  }
}

export async function autoSwapAfterExit(params: {
  receivedTokenMint: string;
  receivedTokenSymbol: string;
  receivedAmount: string;
  wallet: Keypair;
  connection: Connection;
  dryRun: boolean;
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

  // Check minimum value
  const humanAmount = parseHumanAmount(params.receivedAmount);
  if (humanAmount <= 0) {
    result.reason = `Zero or negative amount (${params.receivedAmount})`;
    return result;
  }

  const usdValue = await getTokenValueUsd(
    params.receivedTokenMint,
    humanAmount
  );
  if (usdValue <= CONFIG.autoSwapMinUsd) {
    result.reason = `${params.receivedTokenSymbol} value $${usdValue.toFixed(3)} below $${CONFIG.autoSwapMinUsd.toFixed(2)} minimum`;
    return result;
  }

  // Get decimals and convert to raw amount
  let decimals: number;
  try {
    decimals = await getTokenDecimals(
      params.receivedTokenMint,
      params.connection
    );
  } catch (err) {
    result.reason = `Failed to get token decimals: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }

  const rawAmount = BigInt(Math.round(humanAmount * 10 ** decimals));

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

    const sig = await params.connection.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 2,
    });

    await params.connection.confirmTransaction(sig, CONFIG.commitment);

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
