import type { Attribution } from "@openmapx/mobility-core/attribution";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";

/** Trusted host use only: each element is evidence for one known painted channel.
 * Text uses real Range layout, clipped by its own and ancestor overflow boxes.
 * An overflowing child can paint inside the map even when its root is outside.
 */
export function markerMapContributors(
  container: HTMLElement,
  element: Element | null,
  contributors: readonly Attribution[],
  channel: "geometry" | "text" = "geometry",
): Attribution[] {
  if (!contributors.length || !element?.isConnected || !container.contains(element)) return [];
  const map = container.getBoundingClientRect();
  if (map.width <= 0 || map.height <= 0) return [];
  let left = Math.max(map.left, 0);
  let top = Math.max(map.top, 0);
  let right = Math.min(map.right, window.innerWidth);
  let bottom = Math.min(map.bottom, window.innerHeight);
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      (style.opacity !== "" && Number(style.opacity) === 0)
    )
      return [];
    if (
      channel === "text" &&
      node === element &&
      (style.color === "transparent" ||
        style.color === "rgba(0, 0, 0, 0)" ||
        Number.parseFloat(style.fontSize) === 0)
    )
      return [];
    const clips = (value: string) => ["hidden", "clip", "scroll", "auto"].includes(value);
    const clipX = clips(style.overflowX || style.overflow);
    const clipY = clips(style.overflowY || style.overflow);
    if (clipX || clipY) {
      const bounds = node.getBoundingClientRect();
      if (clipX) {
        left = Math.max(left, bounds.left);
        right = Math.min(right, bounds.right);
      }
      if (clipY) {
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
    }
  }
  if (right <= left || bottom <= top) return [];
  const intersects = (rect: DOMRect) =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > left &&
    rect.left < right &&
    rect.bottom > top &&
    rect.top < bottom;
  if (channel === "geometry")
    return intersects(element.getBoundingClientRect()) ? snapshotContributors(contributors) : [];
  if (!element.textContent?.trim()) return [];
  const range = document.createRange();
  range.selectNodeContents(element);
  const rects =
    typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
  return rects.some(intersects) ? snapshotContributors(contributors) : [];
}
