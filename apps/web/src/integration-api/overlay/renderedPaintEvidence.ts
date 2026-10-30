import type { MapGeoJSONFeature, Map as MapLibreMap } from "maplibre-gl";

type Tile = ReturnType<MapLibreMap["style"]["tileManagers"][string]["getTile"]>;
type SourceFeature = Parameters<Tile["querySourceFeatures"]>[0][number];
type GradientAlpha = "opaque" | "partial" | "transparent" | "missing";

function featureKey(feature: Pick<SourceFeature, "id" | "properties" | "geometry">): string {
  const properties = Object.entries(feature.properties ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  // A stable ID can occur in several differently clipped tiles. Geometry is
  // always part of the key so a neighboring ready tile cannot lend paint proof.
  return JSON.stringify([feature.id ?? null, properties, feature.geometry]);
}

function rampAlpha(value: unknown): GradientAlpha {
  if (
    !value ||
    typeof value !== "object" ||
    !("data" in value) ||
    !(value.data instanceof Uint8Array) ||
    !value.data.length
  )
    return "missing";
  let positive = false;
  let zero = false;
  for (let i = 3; i < value.data.length; i += 4) {
    if ((value.data[i] ?? 0) > 0) positive = true;
    else zero = true;
  }
  return !positive ? "transparent" : zero ? "partial" : "opaque";
}

function patternNames(value: unknown, fade: number | undefined): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (!value || typeof value !== "object") return [];
  if ("name" in value && typeof value.name === "string") return value.name ? [value.name] : [];
  if (fade === undefined || !Number.isFinite(fade) || fade < 0 || fade > 1) return [];
  // Both pattern shaders mix from/to with u_fade = crossfade.t. A loaded
  // endpoint with zero effective weight provides no visible pixels.
  return [
    ...new Set([
      ...(fade < 1 && "from" in value ? patternNames(value.from, fade) : []),
      ...(fade > 0 && "to" in value ? patternNames(value.to, fade) : []),
    ]),
  ];
}

/** Per-refresh host-only evidence cache for MapLibre 6.16 render-produced paint. */
export function createRenderedPaintEvidence(map: MapLibreMap) {
  const indexes = new Map<string, Map<string, Tile[]>>();
  const matchingTiles = (feature: MapGeoJSONFeature): Tile[] => {
    const sourceId = feature.source ?? feature.layer.source;
    const sourceLayer =
      feature.sourceLayer ??
      ("source-layer" in feature.layer ? feature.layer["source-layer"] : undefined);
    const scope = JSON.stringify([sourceId, sourceLayer ?? ""]);
    let index = indexes.get(scope);
    if (!index) {
      index = new Map();
      indexes.set(scope, index);
      const manager = map.style?.tileManagers?.[sourceId];
      // Feature geometry is part of the key; tiles project it through the
      // style's world coordinates, as the public querySourceFeatures does.
      const worldCoordinateHelper = map.style?.projection?.worldCoordinateHelper;
      if (
        !manager ||
        !worldCoordinateHelper ||
        typeof manager.getVisibleCoordinates !== "function" ||
        typeof manager.getTile !== "function"
      )
        return [];
      for (const coordinate of manager.getVisibleCoordinates()) {
        const tile = manager.getTile(coordinate);
        if (!tile?.hasData() || typeof tile.querySourceFeatures !== "function") continue;
        const records: SourceFeature[] = [];
        tile.querySourceFeatures(records, { sourceLayer, worldCoordinateHelper });
        const seen = new Set<string>();
        for (const record of records) {
          const key = featureKey(record);
          if (seen.has(key)) continue;
          seen.add(key);
          const matches = index.get(key) ?? [];
          matches.push(tile);
          index.set(key, matches);
        }
      }
    }
    return index.get(featureKey(feature)) ?? [];
  };

  return {
    gradient(feature: MapGeoJSONFeature, allowPartial: boolean): boolean {
      const layer = map.getLayer(feature.layer.id);
      if (!layer) return false;
      for (const tile of matchingTiles(feature)) {
        const bucket = tile.getBucket(layer);
        if (
          !bucket ||
          !("uploaded" in bucket) ||
          bucket.uploaded !== true ||
          bucket.isEmpty() ||
          !("gradients" in bucket)
        )
          continue;
        const gradients = bucket.gradients;
        if (!gradients || typeof gradients !== "object" || !(layer.id in gradients)) continue;
        const entry: unknown = gradients[layer.id as keyof typeof gradients];
        if (
          !entry ||
          typeof entry !== "object" ||
          !("gradient" in entry) ||
          !("texture" in entry) ||
          !entry.texture
        )
          continue;
        const alpha = rampAlpha(entry.gradient);
        if (alpha === "opaque" || (allowPartial && alpha === "partial")) return true;
      }
      return false;
    },
    pattern(feature: MapGeoJSONFeature, value: unknown, allowTransparent = false): boolean {
      const layer = map.getLayer(feature.layer.id);
      if (!layer) return false;
      // Explicit solid fill outlines are independent of the pattern blend;
      // they still require the pattern's tile to have reached draw readiness.
      const fade = allowTransparent
        ? 0.5
        : typeof layer.getCrossfadeParameters === "function"
          ? layer.getCrossfadeParameters()?.t
          : undefined;
      const names = patternNames(value, fade);
      if (!names.length) return false;
      for (const tile of matchingTiles(feature)) {
        const bucket = tile.getBucket(layer);
        if (
          !bucket ||
          !("uploaded" in bucket) ||
          bucket.uploaded !== true ||
          bucket.isEmpty() ||
          !tile.patternsLoaded() ||
          !tile.imageAtlasTexture ||
          !tile.imageAtlas
        )
          continue;
        const atlas = tile.imageAtlas;
        for (const name of names) {
          const position = atlas.patternPositions[name];
          if (!position) continue;
          if (allowTransparent) return true;
          const [left, top, right, bottom] = position.tlbr;
          for (let y = Math.max(0, top); y < Math.min(atlas.image.height, bottom); y++) {
            for (let x = Math.max(0, left); x < Math.min(atlas.image.width, right); x++) {
              if ((atlas.image.data[(y * atlas.image.width + x) * 4 + 3] ?? 0) > 0) return true;
            }
          }
        }
      }
      return false;
    },
  };
}

export type RenderedPaintEvidence = ReturnType<typeof createRenderedPaintEvidence>;
