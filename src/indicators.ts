import { CONFIG } from "./config";
import { Candle } from "./price-feed";

export interface BollingerBand {
  upper: number;
  middle: number;
  lower: number;
}

export interface MACDData {
  macdLine: number;
  signalLine: number;
  histogram: number;
}

export interface IndicatorSnapshot {
  shouldExit: boolean;
  shouldExitMacd: boolean;
  rsi: number;
  bb: BollingerBand;
  macd: MACDData;
  price: number;
  timestamp: number;
  candleDataSource?: "GMGN" | "DEXPAPRIKA";
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

function calculateEMA(values: number[], period: number): number[] {
  if (values.length < period) {
    throw new Error(
      `EMA requires at least ${period} data points, got ${values.length}`
    );
  }

  const ema: number[] = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  ema[period - 1] = sum / period;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

export function calculateMACD(
  closes: number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number
): MACDData {
  const emaFast = calculateEMA(closes, fastPeriod);
  const emaSlow = calculateEMA(closes, slowPeriod);

  const macdLine: number[] = new Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (Number.isFinite(emaFast[i]) && Number.isFinite(emaSlow[i])) {
      macdLine[i] = emaFast[i] - emaSlow[i];
    }
  }

  const firstValid = macdLine.findIndex((v) => Number.isFinite(v));
  if (firstValid === -1) {
    throw new Error("MACD could not be computed");
  }

  const valid = macdLine.slice(firstValid);
  const signalValid = calculateEMA(valid, signalPeriod);
  const signalLine: number[] = new Array(closes.length).fill(NaN);
  for (let i = 0; i < valid.length; i++) {
    signalLine[firstValid + i] = signalValid[i];
  }

  const last = closes.length - 1;
  const macd = macdLine[last];
  const sig = signalLine[last];
  const histogram = Number.isFinite(macd) && Number.isFinite(sig) ? macd - sig : NaN;

  if (!Number.isFinite(macd) || !Number.isFinite(sig) || !Number.isFinite(histogram)) {
    throw new Error("MACD value is NaN");
  }

  return { macdLine: macd, signalLine: sig, histogram };
}

export function checkExitConditions(
  candles: Candle[],
  candleDataSource?: "GMGN" | "DEXPAPRIKA"
): IndicatorSnapshot {
  const closes = candles.map((c) => c.close);
  const lastCandle = candles[candles.length - 1];
  const price = lastCandle.close;
  const fallback: IndicatorSnapshot = {
    shouldExit: false,
    shouldExitMacd: false,
    rsi: 0,
    bb: { upper: 0, middle: 0, lower: 0 },
    macd: { macdLine: 0, signalLine: 0, histogram: 0 },
    price,
    timestamp: lastCandle.timestamp,
    candleDataSource,
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

  let macd: MACDData;
  try {
    macd = calculateMACD(
      closes,
      CONFIG.macdFastPeriod,
      CONFIG.macdSlowPeriod,
      CONFIG.macdSignalPeriod
    );
  } catch {
    return fallback;
  }

  const bbExitPrice = bb[CONFIG.bbExitBand];
  const shouldExit = rsiValue >= CONFIG.rsiThreshold && price > bbExitPrice;
  const shouldExitMacd =
    rsiValue >= CONFIG.rsiThreshold && macd.histogram > 0;

  return {
    shouldExit,
    shouldExitMacd,
    rsi: rsiValue,
    bb,
    macd,
    price,
    timestamp: lastCandle.timestamp,
    candleDataSource,
  };
}
