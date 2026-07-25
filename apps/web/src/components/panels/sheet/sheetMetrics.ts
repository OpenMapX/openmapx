export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * How much of the sheet is on screen right now.
 *
 * The sheet host is a fixed-height scroll container: its height never changes,
 * only its scroll offset does, so the rendered sheet height has to be derived
 * rather than measured. The scrollable overflow equals the sheet's own height,
 * so visible height is simply how far the host has been scrolled.
 */
export function visibleSheetHeight({
  scrollTop,
  scrollHeight,
  clientHeight,
}: ScrollGeometry): number {
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  const visible = Math.min(scrollTop, maxScroll);
  return Math.max(0, Math.min(visible, clientHeight));
}
