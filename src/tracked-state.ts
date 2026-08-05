import { ActivePosition } from "./position-fetcher";

export type PositionState = "MONITORING" | "EXIT_TRIGGERED" | "EXITING" | "EXITED";
export type ExitTriggerType = "HARD_STOP_LOSS" | "RSI_BB" | "RSI_MACD" | "TRAILING_PROFIT";
export type BBExitBand = "upper" | "middle" | "lower";

export interface ExitSignalContext {
  triggerType: ExitTriggerType;
  rsi: number;
  price: number;
  bbExitBand: BBExitBand;
  bbExitPrice: number;
  peakPnlSol?: number;
  peakPnlPercent?: number;
  trailingDropPercent?: number;
  macdLine?: number;
  macdSignal?: number;
  macdHistogram?: number;
  candleDataSource?: "GMGN" | "DEXPAPRIKA";
}

export interface TrackedPosition {
  position: ActivePosition;
  state: PositionState;
  exitTriggerType?: ExitTriggerType;
  exitSignal?: ExitSignalContext;
}

let trackedPositions: TrackedPosition[] = [];

export function setTrackedPositions(list: TrackedPosition[]): void {
  trackedPositions = list;
}

export function getTrackedPositions(): TrackedPosition[] {
  return trackedPositions;
}

export function getTrackedPositionsSnapshot(): ActivePosition[] {
  return trackedPositions
    .filter((t) => t.state !== "EXITED")
    .map((t) => t.position);
}