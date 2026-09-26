export function resolveControlPlacement(
  viewportHeight: number,
  topInset: number,
  bottom: number,
  columnHeight: number,
  gridHeight: number,
): { columns: 1 | 2; bottom: number } {
  const topLimit = topInset + 12;
  if (viewportHeight - bottom - columnHeight >= topLimit) return { columns: 1, bottom };
  return {
    columns: 2,
    bottom: Math.min(bottom, viewportHeight - topLimit - gridHeight),
  };
}
