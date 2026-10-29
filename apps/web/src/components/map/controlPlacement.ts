/** The highest bottom offset at which the two-column grid stays below top chrome. */
export function gridCeiling(
  viewportHeight: number,
  topInset: number,
  gridHeight: number,
  safeBottom: number,
): number {
  return viewportHeight - safeBottom - (topInset + 12) - gridHeight;
}

export function resolveControlPlacement(
  viewportHeight: number,
  topInset: number,
  bottom: number,
  columnHeight: number,
  gridHeight: number,
  safeBottom: number,
): { columns: 1 | 2; bottom: number } {
  const topLimit = topInset + 12;
  if (viewportHeight - safeBottom - bottom - columnHeight >= topLimit)
    return { columns: 1, bottom };
  return {
    columns: 2,
    bottom: Math.min(bottom, gridCeiling(viewportHeight, topInset, gridHeight, safeBottom)),
  };
}
