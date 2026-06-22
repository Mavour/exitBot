import { CONFIG } from "./config";
import { Candle } from "./price-feed";

export interface BollingerBand {
  upper: number;
  middle: number;
  lower: number;
}

export interface IndicatorSnapshot {
  shouldExit: boolean;
  smoothedRsi: number;
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

export function applySMA(values: number[], length: number): number[] {
  const result: number[] = new Array(values.length).fill(NaN);

  // Get only non-NaN values for computation
  const validIndices: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (!isNaN(values[i])) {
      validIndices.push(i);
    }
  }

  const validValues = validIndices.map((i) => values[i]);

  if (validValues.length < length) {
    return result;
  }

  let sum = 0;
  for (let i = 0; i < length; i++) {
    sum += validValues[i];
  }

  result[validIndices[length - 1]] = sum / length;

  for (let i = length; i < validValues.length; i++) {
    sum += validValues[i] - validValues[i - length];
    result[validIndices[i]] = sum / length;
  }

  return result;
}

export function getSmoothedRSI(
  closes: number[],
  rsiPeriod: number,
  smoothingLength: number
): number {
  const raw = calculateRawRSI(closes, rsiPeriod);
  const smoothed = applySMA(raw, smoothingLength);
  const last = smoothed[smoothed.length - 1];
  if (isNaN(last)) {
    throw new Error(
      `Not enough data for smoothed RSI. ` +
      `Need at least ${rsiPeriod + smoothingLength + 5} candles, got ${closes.length}`
    );
  }
  return last;
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
    smoothedRsi: 0,
    bb: { upper: 0, middle: 0, lower: 0 },
    price,
    timestamp: lastCandle.timestamp,
  };

  let smoothedRsi: number;
  try {
    smoothedRsi = getSmoothedRSI(
      closes,
      CONFIG.rsiPeriod,
      CONFIG.rsiSmoothingLength
    );
  } catch {
    return fallback;
  }

  let bb: BollingerBand;
  try {
    bb = calculateBB(closes, CONFIG.bbPeriod, CONFIG.bbStdDev);
  } catch {
    return fallback;
  }

  const shouldExit = smoothedRsi >= CONFIG.rsiThreshold && price > bb.upper;

  return {
    shouldExit,
    smoothedRsi,
    bb,
    price,
    timestamp: lastCandle.timestamp,
  };
}
