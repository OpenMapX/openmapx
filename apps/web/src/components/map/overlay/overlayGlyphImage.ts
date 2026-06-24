import type { IntegrationOverlayImage } from "@openmapx/integration-framework";
import type { Map as MaplibreMap } from "maplibre-gl";

// Device pixels of the registered glyph image. Registered at pixelRatio 2, so it
// displays at 24px when a symbol layer's icon-size is 1; the layer scales from there.
const GLYPH_DEVICE_PX = 48;
// Fraction of the image the 24×24 source path fills, leaving a margin for the outline.
const GLYPH_FILL = 0.66;

/**
 * Rasterize a declarative overlay's 24×24 SVG path into a white glyph (with a
 * thin dark outline for contrast on any marker color) and register it with the
 * map under `image.id`, so a symbol layer can reference it via `icon-image`.
 *
 * Synchronous (Path2D → canvas → ImageData) so the image exists before the
 * symbol layer that references it is added — no missing-image warning, no async
 * race. No-op if the id is already registered (e.g. re-entrant style syncs).
 */
export function registerOverlayGlyph(map: MaplibreMap, image: IntegrationOverlayImage): void {
  if (map.hasImage(image.id)) return;

  const canvas = document.createElement("canvas");
  canvas.width = GLYPH_DEVICE_PX;
  canvas.height = GLYPH_DEVICE_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const scale = (GLYPH_DEVICE_PX * GLYPH_FILL) / 24;
  ctx.translate(GLYPH_DEVICE_PX / 2, GLYPH_DEVICE_PX / 2);
  ctx.scale(scale, scale);
  ctx.translate(-12, -12);

  const path = new Path2D(image.path);
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 1.1;
  ctx.stroke(path);
  ctx.fillStyle = "#ffffff";
  ctx.fill(path);

  const data = ctx.getImageData(0, 0, GLYPH_DEVICE_PX, GLYPH_DEVICE_PX);
  // Guard again: a concurrent sync may have registered it while we rasterized.
  if (!map.hasImage(image.id)) map.addImage(image.id, data, { pixelRatio: 2 });
}
