import Point from "@mapbox/point-geometry";
import type { MapGeoJSONFeature, Map as MapLibreMap, OverscaledTileID } from "maplibre-gl";
import { difference, intersection, union } from "polyclip-ts";
import { type MultiPolygon, simpleRegions } from "./nativeRasterCoverage";
import { visibleNativeTileDomain } from "./nativeTileDomain";
import { prepareRasterContainment, tileRectangleInWorld } from "./rasterDomainContainment";

/** Pinned MapLibre 6.13 host adapter, never an installed extension API. Symbols
 * use the ordinary collision query. This path preserves FeatureIndex's own
 * filter/state/evaluated width/paint behavior for tile-clipped fill and line. */
export function queryNativeTileDomains(
  map: MapLibreMap,
  ids: readonly string[],
  opaque: MultiPolygon,
  accept: (feature: MapGeoJSONFeature) => void,
  complete: () => boolean,
): boolean {
  const frame = map.painter.frameRenderContext;
  const covered = prepareRasterContainment(opaque);
  const layers = Object.fromEntries(
    ids.flatMap((id) => {
      const l = map.style.getLayer(id);
      return l ? [[id, l]] : [];
    }),
  );
  if (Object.values(layers).some((l) => l.type !== "fill" && l.type !== "line")) return false;
  const serialized = Object.fromEntries(
    (map.getStyle()?.layers ?? []).filter((l) => ids.includes(l.id)).map((l) => [l.id, l]),
  );
  const sources = [...new Set(Object.values(layers).map((l) => l.source))];
  for (const source of sources) {
    const manager = map.style.tileManagers[source];
    if (!manager) continue;
    const coordinates = manager.getVisibleCoordinates();
    for (const coord of coordinates) {
      if (complete()) return true;
      const tile = manager.getTile(coord);
      if (!tile?.hasData() || tile.holdingForSymbolFade()) continue;
      // Native stencil includes the renderer's 64-unit border. Do not erase
      // geometry spilling out of an otherwise covered tile into a raster hole.
      const y0 = coord.canonical.y === 0 ? -32768 : -64;
      const y1 = coord.canonical.y === 2 ** coord.canonical.z - 1 ? 32767 : 8256;
      if (covered(tileRectangleInWorld(coord, [-64, y0, 8256, y1]))) continue;
      const bounds: MultiPolygon = [
        [
          [
            [-64, y0],
            [8256, y0],
            [8256, y1],
            [-64, y1],
            [-64, y0],
          ],
        ],
      ];
      const matrix = new Float32Array([
        frame.transform.width / 2,
        0,
        0,
        0,
        0,
        frame.transform.height / 2,
        0,
        0,
        0,
        0,
        1,
        0,
        1,
        1,
        0,
        1,
      ]);
      const query = (ring: import("./nativeRasterCoverage").Ring) => {
        const geometry = ring.map((p) => new Point(p[0], p[1]));
        return tile.queryRenderedFeatures(
          layers,
          serialized,
          manager.getState(),
          geometry,
          geometry,
          2 ** (frame.transform.zoom - coord.overscaledZ),
          { layers: new Set(ids), availableImages: map.listImages() },
          frame.transform,
          frame.transform.maxPitchScaleFactor(),
          matrix,
          undefined,
        );
      };
      // Negative-only preflight: empty FeatureIndex results cannot become
      // positive after clipping. Never publish these potentially off-globe hits.
      if (
        !Object.values(query(bounds[0][0] as import("./nativeRasterCoverage").Ring)).some(
          (hits) => hits.length,
        )
      )
        continue;
      const localMask = worldToTile(opaque, coord);
      const rawExposure = localMask.length ? difference(bounds, localMask) : bounds;
      if (!rawExposure.length) continue;
      if (
        !simpleRegions(rawExposure).some((ring) =>
          Object.values(query(ring)).some((hits) => hits.length),
        )
      )
        continue;
      const domain = visibleNativeTileDomain(frame, coord, false, localMask);
      if (!domain) return false;
      const visibleExposure = intersection(rawExposure, domain);
      if (!visibleExposure.length) continue;
      const owned = nativeStencilOwnership(coord, coordinates);
      const visible = intersection(visibleExposure, owned);
      const inspect = (ring: import("./nativeRasterCoverage").Ring) => {
        const result = query(ring);
        for (const hits of Object.values(result))
          for (const hit of hits) {
            const feature = hit.feature as MapGeoJSONFeature;
            feature.source = feature.layer.source;
            feature.sourceLayer =
              "source-layer" in feature.layer ? feature.layer["source-layer"] : undefined;
            feature.state =
              feature.id === undefined
                ? {}
                : manager.getFeatureState(feature.sourceLayer ?? "", feature.id);
            accept(feature);
          }
      };
      for (const ring of simpleRegions(visible)) {
        if (complete()) return true;
        inspect(ring);
      }
    }
  }
  return true;
}
export function worldToTile(mask: MultiPolygon, coord: OverscaledTileID): MultiPolygon {
  const scale = 2 ** coord.canonical.z;
  return mask.map((p) =>
    p.map((r) =>
      r.map(([x, y]) => [
        (x - coord.wrap) * scale * 8192 - coord.canonical.x * 8192,
        y * scale * 8192 - coord.canonical.y * 8192,
      ]),
    ),
  );
}
export function nativeBackgroundExposed(
  map: MapLibreMap,
  opaque: MultiPolygon,
): boolean | undefined {
  const frame = map.painter.frameRenderContext;
  const covered = prepareRasterContainment(opaque);
  for (const coord of map.coveringTiles({ tileSize: frame.transform.tileSize })) {
    const y0 = coord.canonical.y === 0 ? -32768 : 0,
      y1 = coord.canonical.y === 2 ** coord.canonical.z - 1 ? 32767 : 8192;
    if (covered(tileRectangleInWorld(coord, [0, y0, 8192, y1]))) continue;
    const mask = worldToTile(opaque, coord);
    const bounds: MultiPolygon = [
      [
        [
          [0, y0],
          [8192, y0],
          [8192, y1],
          [0, y1],
          [0, y0],
        ],
      ],
    ];
    const exposed = mask.length ? difference(bounds, mask) : bounds;
    if (!exposed.length) continue;
    const domain = visibleNativeTileDomain(frame, coord, true, mask);
    if (!domain) return undefined;
    if (intersection(exposed, domain).length) return true;
  }
  return false;
}

/** Native renderer writes every border, then every interior in this coordinate
 * order. Resolve that precedence in the same dyadic geographic domain before
 * intersecting the actual front/frustum-clipped mesh. Neighbor interiors own
 * their pixels even when this tile's buffered vector geometry extends there. */
export function nativeStencilOwnership(
  coord: OverscaledTileID,
  coordinates: readonly OverscaledTileID[],
): MultiPolygon {
  const local = (other: OverscaledTileID, border: boolean): MultiPolygon => {
    const scale = 2 ** other.canonical.z,
      b = border ? 64 / 8192 / scale : 0;
    const x = other.wrap + other.canonical.x / scale,
      y = other.canonical.y / scale,
      d = 1 / scale;
    const y0 = other.canonical.y === 0 ? -4 : y - b;
    const y1 = other.canonical.y === scale - 1 ? 5 : y + d + b;
    return worldToTile(
      [
        [
          [
            [x - b, y0],
            [x + d + b, y0],
            [x + d + b, y1],
            [x - b, y1],
            [x - b, y0],
          ],
        ],
      ],
      coord,
    );
  };
  const index = coordinates.indexOf(coord);
  const core = local(coord, false),
    border = local(coord, true);
  const later = coordinates.slice(index + 1);
  const bounds = border[0][0];
  const overlaps = (p: MultiPolygon) => {
    const r = p[0][0];
    return (
      r[0][0] < bounds[1][0] &&
      r[1][0] > bounds[0][0] &&
      r[0][1] < bounds[2][1] &&
      r[2][1] > bounds[0][1]
    );
  };
  const allCores = coordinates.map((c) => local(c, false)).filter(overlaps);
  const laterCores = later.map((c) => local(c, false)).filter(overlaps),
    laterBorders = later.map((c) => local(c, true)).filter(overlaps);
  const ownCore = laterCores.length
    ? difference(core, union(laterCores[0], ...laterCores.slice(1)))
    : core;
  const blockers = [...allCores, ...laterBorders];
  const ownBorder = difference(border, union(blockers[0], ...blockers.slice(1)));
  return union(ownCore, ownBorder);
}

/** Exact ordinary engine query inputs, with attribution-specific early stopping.
 * This adapter does not use the screen inverse as a raster occlusion proof on
 * the globe. It is the native engine evidence path when no globe mask applies. */
export function queryNativeScreenDomains(
  map: MapLibreMap,
  ids: readonly string[],
  regions: import("./nativeRasterCoverage").Ring[] | undefined,
  accept: (feature: MapGeoJSONFeature) => void,
  complete: () => boolean,
): boolean {
  const frame = map.painter?.frameRenderContext;
  if (!frame || frame.terrain || !map.style.tileManagers) return false;
  const layers = Object.fromEntries(
    ids.flatMap((id) => {
      const layer = map.style.getLayer(id);
      return layer ? [[id, layer]] : [];
    }),
  );
  if (Object.values(layers).some((l) => l.type === "symbol" || l.type === "fill-extrusion"))
    return false;
  const serialized = Object.fromEntries(
    (map.getStyle()?.layers ?? []).filter((l) => ids.includes(l.id)).map((l) => [l.id, l]),
  );
  const transform = frame.transform;
  const maxPitch = transform.maxPitchScaleFactor();
  const availableImages = map.listImages();
  const rings = regions ?? [
    [
      [0, 0],
      [transform.width, 0],
      [transform.width, transform.height],
      [0, transform.height],
      [0, 0],
    ],
  ];
  for (const ring of rings) {
    const geometry = ring.map((p) => new Point(p[0], p[1]));
    for (const source of new Set(Object.values(layers).map((l) => l.source))) {
      const manager = map.style.tileManagers[source];
      if (!manager) continue;
      const sourceIds = ids.filter((id) => layers[id]?.source === source);
      for (const input of manager.tilesIn(geometry, maxPitch, false)) {
        if (complete()) return true;
        const projection = transform.getFastPathSimpleProjectionMatrix(input.tileID);
        const matrix = projection
          ? new Float32Array(16)
          : new Float32Array([
              transform.width / 2,
              0,
              0,
              0,
              0,
              transform.height / 2,
              0,
              0,
              0,
              0,
              1,
              0,
              1,
              1,
              0,
              1,
            ]);
        if (projection)
          for (let column = 0; column < 4; column++) {
            const i = column * 4;
            matrix[i] = (transform.width / 2) * projection[i] + projection[i + 3];
            matrix[i + 1] = (transform.height / 2) * projection[i + 1] + projection[i + 3];
            matrix[i + 2] = projection[i + 2];
            matrix[i + 3] = projection[i + 3];
          }
        // A single positive layer can prove the shared source/style receipts.
        // Avoid materializing every feature in every equivalent style layer.
        for (const id of sourceIds) {
          if (complete()) return true;
          const result = input.tile.queryRenderedFeatures(
            layers,
            serialized,
            manager.getState(),
            input.queryGeometry,
            input.cameraQueryGeometry,
            input.scale,
            { layers: new Set([id]), availableImages },
            transform,
            maxPitch,
            matrix,
            undefined,
          );
          for (const hits of Object.values(result))
            for (const hit of hits) {
              const feature = hit.feature as MapGeoJSONFeature;
              feature.source = feature.layer.source;
              feature.sourceLayer =
                "source-layer" in feature.layer ? feature.layer["source-layer"] : undefined;
              feature.state =
                feature.id === undefined
                  ? {}
                  : manager.getFeatureState(feature.sourceLayer ?? "", feature.id);
              accept(feature);
            }
        }
      }
    }
  }
  return true;
}
