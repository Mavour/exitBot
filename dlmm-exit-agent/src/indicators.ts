import { CONFIG } from "./config";
import { Candle } from "./price-feed";

export interface BollingerBand {
  upper: number;
  middle: number;
  lower: number;
}

export function calculateRSI(closes: number[], period: number): number {
  if (closes.length < period + 1) {
    throw new Error(
      `RSI requires at least ${period + 1} data points, got ${closes.length}`
    );
  }

  // Calculate price changes
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  // Wilder's smoothed moving average
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calculateBB(
  closes: number[],
  period: number,
  stdDevMult: number
): BollingerBand {
  if (closes.length < period) {
    throw new Error(
      `BB requires at least ${period} data points, got ${closes.length}`
    );
  }

  // Use last `period` candles for the SMA
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;

  // Population standard deviation
  const squaredDiffs = slice.map((v) => (v - sma) ** 2);
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: sma + stdDevMult * stdDev,
    middle: sma,
    lower: sma - stdDevMult * stdDev,
  };
}

export function checkExitConditions(candles: Candle[]): {
  shouldExit: boolean;
  rsi: number;
  bb: BollingerBand;
  price: number;
} {
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];

  const rsi = calculateRSI(closes, CONFIG.rsiPeriod);
  const bb = calculateBB(closes, CONFIG.bbPeriod, CONFIG.bbStdDev);

  const shouldExit = rsi >= CONFIG.rsiThreshold && price > bb.upper;

  return { shouldExit, rsi, bb, price };
}
