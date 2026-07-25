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

/**
 * The height the sheet should collapse to.
 *
 * A panel renders more inside its peek subtree while the sheet is open than it
 * keeps when collapsed — meta rows that drop out at peek, say. Measuring the
 * subtree as it stands would aim the collapse at a height that stops existing
 * the moment it lands, and the sheet would re-anchor lower right after
 * settling. Discounting those parts makes the target the collapsed height at
 * every detent, so there is nothing to correct on arrival.
 */
export function peekContentHeight(
  subtreeHeight: number,
  hiddenAtPeekHeights: readonly number[],
  headerHeight: number,
): number {
  const hidden = hiddenAtPeekHeights.reduce((sum, h) => sum + Math.max(0, h), 0);
  return Math.max(0, Math.round(subtreeHeight - hidden + headerHeight));
}
