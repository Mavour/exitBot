import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { CONFIG } from "./config";
import { log } from "./logger";
import { getConnection, withRpcFallback } from "./rpc-manager";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodeBase58(input: string): Uint8Array {
  const base = BigInt(58);
  let num = BigInt(0);
  for (let i = 0; i < input.length; i++) {
    const idx = BASE58_ALPHABET.indexOf(input[i]);
    if (idx === -1) throw new Error(`Invalid base58 character: ${input[i]}`);
    num = num * base + BigInt(idx);
  }
  const bytes: number[] = [];
  while (num > 0) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  // Preserve leading zeros
  let leadingZeros = 0;
  for (let i = 0; i < input.length && input[i] === "1"; i++) {
    leadingZeros++;
  }
  const result = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < leadingZeros; i++) result[i] = 0;
  for (let i = 0; i < bytes.length; i++) result[leadingZeros + i] = bytes[i];
  return result;
}

function loadKeypair(privateKeyStr: string): Keypair {
  // Try base58 first
  try {
    const decoded = decodeBase58(privateKeyStr);
    if (decoded.length === 64) {
      return Keypair.fromSecretKey(decoded);
    }
  } catch {
    // Not base58, try JSON uint8array
  }

  // Try JSON uint8array format (e.g. [123,45,...])
  try {
    const parsed = JSON.parse(privateKeyStr);
    if (Array.isArray(parsed) && parsed.length === 64) {
      return Keypair.fromSecretKey(Uint8Array.from(parsed));
    }
  } catch {
    // Not valid JSON either
  }

  // Try raw uint8array string without brackets
  try {
    const numbers = privateKeyStr.split(",").map((s) => Number(s.trim()));
    if (numbers.length === 64 && numbers.every((n) => !isNaN(n))) {
      return Keypair.fromSecretKey(Uint8Array.from(numbers));
    }
  } catch {
    // Give up
  }

  throw new Error(
    "WALLET_PRIVATE_KEY: unable to parse. Provide a base58 string or a JSON uint8 array."
  );
}

export const connection = getConnection();

export const wallet = loadKeypair(CONFIG.walletPrivateKey);

export async function logWalletInfo(): Promise<void> {
  const balance = await withRpcFallback(conn => conn.getBalance(wallet.publicKey));
  log("INFO", "Wallet loaded", {
    publicKey: wallet.publicKey.toBase58(),
    balanceSol: (balance / LAMPORTS_PER_SOL).toFixed(4),
  });

  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    log("WARN", "Wallet SOL balance is very low — may not cover transaction fees");
  }
}
