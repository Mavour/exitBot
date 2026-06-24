import { CONFIG } from "./config";
import { Candle } from "./price-feed";

export interface BollingerBand {
  upper: number;
  middle: number;
  lower: number;
}

export interface IndicatorSnapshot {
  shouldExit: boolean;
  rsi: number;
  bb: BollingerBand;
  price: number;
  timestamp: number;
}

export function calculateRawRSI(closes: number[], period: number): number[] {
  if (closes.length < period + 1) {
    throw new Error(
      `RSI requires at least ${period + 1} data points, got ${closes.length}`
    );
  }

  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  // Wilder's RMA smoothing (repeated for each step)
  const rsiValues: number[] = new Array(closes.length).fill(NaN);

  // Seed with simple average of first `period` gains/losses
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // First valid RSI at index = period
  for (let i = period - 1; i < gains.length; i++) {
    if (i > period - 1) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
    // RSI index in `closes` = i + 1 (because gains/losses are offset by 1)
    const rsiIdx = i + 1;
    if (avgLoss === 0) {
      rsiValues[rsiIdx] = 100;
    } else {
      const rs = avgGain / avgLoss;
      rsiValues[rsiIdx] = 100 - 100 / (1 + rs);
    }
  }

  return rsiValues;
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

  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;

  // Population standard deviation (divide by N, not N-1)
  const squaredDiffs = slice.map((v) => (v - sma) ** 2);
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: sma + stdDevMult * stdDev,
    middle: sma,
    lower: sma - stdDevMult * stdDev,
  };
}

export function checkExitConditions(candles: Candle[]): IndicatorSnapshot {
  const closes = candles.map((c) => c.close);
  const lastCandle = candles[candles.length - 1];
  const price = lastCandle.close;
  const fallback: IndicatorSnapshot = {
    shouldExit: false,
    rsi: 0,
    bb: { upper: 0, middle: 0, lower: 0 },
    price,
    timestamp: lastCandle.timestamp,
  };

  let rsiValue: number;
  try {
    const rawRsi = calculateRawRSI(closes, CONFIG.rsiPeriod);
    rsiValue = rawRsi[rawRsi.length - 1];
    if (isNaN(rsiValue)) throw new Error("RSI value is NaN");
  } catch {
    return fallback;
  }

  let bb: BollingerBand;
  try {
    bb = calculateBB(closes, CONFIG.bbPeriod, CONFIG.bbStdDev);
  } catch {
    return fallback;
  }

  const bbExitPrice = bb[CONFIG.bbExitBand];
  const shouldExit = rsiValue >= CONFIG.rsiThreshold && price > bbExitPrice;

  return {
    shouldExit,
    rsi: rsiValue,
    bb,
    price,
    timestamp: lastCandle.timestamp,
  };
}
