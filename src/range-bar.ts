export function renderRangeBar(
  activeBinId: number | null,
  fromBinId: number,
  toBinId: number,
  barWidth: number = 20
): string {
  if (activeBinId === null || fromBinId === toBinId) {
    return "─".repeat(barWidth);
  }

  const ratio = (activeBinId - fromBinId) / (toBinId - fromBinId);

  if (ratio < 0) {
    return "◀●" + "─".repeat(barWidth - 2);
  }

  if (ratio > 1) {
    return "─".repeat(barWidth - 2) + "●▶";
  }

  const position = Math.round(ratio * (barWidth - 1));
  const bar = Array.from({ length: barWidth }, () => "─");
  bar[position] = "●";
  return bar.join("");
}
