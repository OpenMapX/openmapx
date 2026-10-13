import type { MapGeoJSONFeature, Map as MapLibreMap } from "maplibre-gl";
import { createRenderedPaintEvidence, type RenderedPaintEvidence } from "./renderedPaintEvidence";

/** Source maxzoom is deliberately ignored: MapLibre retains overzoomed tiles. */
export function isAttributionLayerVisible(map: MapLibreMap, id: string): boolean {
  const layer = map.getLayer(id);
  const zoom = map.getZoom();
  return (
    !!layer &&
    zoom >= (layer.minzoom ?? 0) &&
    zoom < (layer.maxzoom ?? 24) &&
    (typeof layer.isHidden === "function"
      ? !layer.isHidden(zoom)
      : map.getLayoutProperty(id, "visibility") !== "none")
  );
}

function hasImage(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  return (
    !!value &&
    typeof value === "object" &&
    "name" in value &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    !("available" in value && value.available === false)
  );
}

function hasText(value: unknown, color: unknown, halo: boolean): boolean {
  if (typeof value === "string") return value.length > 0 && (hasAlpha(color) || halo);
  // MapLibre evaluates text-field to a Formatted value, including an empty
  // sections array when only the icon is placed. This is not a style evaluator.
  if (
    !value ||
    typeof value !== "object" ||
    !("sections" in value) ||
    !Array.isArray(value.sections)
  )
    return false;
  return value.sections.some(
    (section: unknown) =>
      !!section &&
      typeof section === "object" &&
      (("text" in section &&
        typeof section.text === "string" &&
        section.text.length > 0 &&
        (hasAlpha("textColor" in section ? (section.textColor ?? color) : color) || halo)) ||
        ("image" in section && hasImage(section.image))),
  );
}

/** Query results carry MapLibre's evaluated values, not raw style expressions. */
function hasAlpha(value: unknown): boolean {
  // The query API evaluates colors to MapLibre Color objects. Do not parse
  // raw CSS strings or style expressions here.
  return (
    !(value && typeof value === "object" && "a" in value && typeof value.a === "number") ||
    value.a > 0
  );
}

function hasHeatmapRampAlpha(map: MapLibreMap, id: string): boolean {
  const layer = map.getLayer(id);
  if (!layer || !("colorRamp" in layer)) return true;
  const ramp = layer.colorRamp;
  if (!ramp || typeof ramp !== "object" || !("data" in ramp) || !(ramp.data instanceof Uint8Array))
    return true;
  // heatmap-color queries expose a boolean ColorRampProperty. Inspect the
  // public precomputed RGBA ramp rather than evaluating that expression again.
  // Host author contract: alpha remains positive at every positive density;
  // selective transparent density ranges need a separately proven renderer.
  for (let i = 3; i < ramp.data.length; i += 4) if ((ramp.data[i] ?? 0) > 0) return true;
  return false;
}

export function hasVisibleFeatureChannel(
  feature: MapGeoJSONFeature,
  map: MapLibreMap,
  evidence: RenderedPaintEvidence = createRenderedPaintEvidence(map),
  allowPartialGradient = false,
): boolean {
  const { type, paint, layout } = feature.layer;
  const evaluatedPaint = paint as Record<string, unknown> | undefined;
  const positive = (key: string, fallback: number) => {
    const value = evaluatedPaint?.[key];
    return typeof value === "number" ? value > 0 : fallback > 0;
  };
  switch (type) {
    case "line":
      return (
        positive("line-opacity", 1) &&
        positive("line-layer-opacity", 1) &&
        positive("line-width", 1) &&
        (evaluatedPaint?.["line-pattern"] !== undefined
          ? evidence.pattern(feature, evaluatedPaint["line-pattern"])
          : evaluatedPaint?.["line-gradient"]
            ? evidence.gradient(feature, allowPartialGradient)
            : hasAlpha(evaluatedPaint?.["line-color"]))
      );
    case "circle":
      return (
        (positive("circle-radius", 5) &&
          positive("circle-opacity", 1) &&
          hasAlpha(evaluatedPaint?.["circle-color"])) ||
        (positive("circle-stroke-width", 0) &&
          positive("circle-stroke-opacity", 1) &&
          hasAlpha(evaluatedPaint?.["circle-stroke-color"]))
      );
    case "symbol": {
      const symbolLayout = layout as Record<string, unknown> | undefined;
      const icon = symbolLayout?.["icon-image"];
      const text = symbolLayout?.["text-field"];
      const iconSize = symbolLayout?.["icon-size"];
      const textSize = symbolLayout?.["text-size"];
      return (
        (hasImage(icon) &&
          (typeof iconSize !== "number" || iconSize > 0) &&
          positive("icon-opacity", 1)) ||
        (hasText(
          text,
          evaluatedPaint?.["text-color"],
          positive("text-halo-width", 0) &&
            evaluatedPaint?.["text-halo-color"] !== undefined &&
            hasAlpha(evaluatedPaint["text-halo-color"]),
        ) &&
          (typeof textSize !== "number" || textSize > 0) &&
          positive("text-opacity", 1))
      );
    }
    case "fill":
      return (
        positive("fill-opacity", 1) &&
        positive("fill-layer-opacity", 1) &&
        (evaluatedPaint?.["fill-pattern"] !== undefined
          ? evidence.pattern(feature, evaluatedPaint["fill-pattern"]) ||
            (evaluatedPaint?.["fill-antialias"] !== false &&
              evaluatedPaint?.["fill-outline-color"] !== undefined &&
              hasAlpha(evaluatedPaint["fill-outline-color"]) &&
              evidence.pattern(feature, evaluatedPaint["fill-pattern"], true))
          : hasAlpha(evaluatedPaint?.["fill-color"]) ||
            (evaluatedPaint?.["fill-antialias"] !== false &&
              hasAlpha(evaluatedPaint?.["fill-outline-color"] ?? evaluatedPaint?.["fill-color"])))
      );
    case "fill-extrusion":
      // The engine ignores extrusion color alpha and still draws the polygon
      // roof at height === base; opacity is the relevant channel gate.
      return positive("fill-extrusion-opacity", 1);
    case "heatmap":
      return (
        positive("heatmap-opacity", 1) &&
        positive("heatmap-weight", 1) &&
        positive("heatmap-intensity", 1) &&
        positive("heatmap-radius", 30) &&
        hasHeatmapRampAlpha(map, feature.layer.id)
      );
    default:
      return false;
  }
}
