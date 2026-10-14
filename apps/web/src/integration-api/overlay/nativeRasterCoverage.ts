import earcut, { flatten } from "earcut";
import type { Map as MapLibreMap } from "maplibre-gl";
import { difference, union } from "polyclip-ts";
export type MultiPolygon = ReturnType<typeof union>;
export type Ring = MultiPolygon[number][number];
export function evaluatedNativePaint(value: unknown): { get(name: string): unknown } | undefined {
  return value && typeof value === "object" && "get" in value && typeof value.get === "function"
    ? (value as { get(name: string): unknown })
    : undefined;
}

import { projectMercatorMask, retainedTileDomain } from "./mercatorRasterMask";
import { retainedRasterOpacity } from "./rasterMapContribution";
import { isAttributionLayerVisible } from "./renderedFeatureVisibility";

/** Project the renderer's exact Mercator tile quad. Clip BEFORE dividing by w:
 * horizon/near-plane crossings at high pitch must not become giant false masks. */
export function projectTileFootprint(
  matrix: ArrayLike<number>,
  width: number,
  height: number,
): Ring | undefined {
  if (matrix.length !== 16 || Array.from(matrix).some((v) => !Number.isFinite(v))) return undefined;
  let polygon = [
    [0, 0],
    [8192, 0],
    [8192, 8192],
    [0, 8192],
  ].map(([x, y]) => [
    matrix[0] * x + matrix[4] * y + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[14],
    matrix[3] * x + matrix[7] * y + matrix[15],
  ]);
  for (const [axis, sign] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [2, 1],
    [2, -1],
  ]) {
    const output: number[][] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length];
      const da = a[3] + sign * a[axis],
        db = b[3] + sign * b[axis];
      if (da >= 0) output.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        const intersection = a.map((v, j) => v + t * (b[j] - v));
        intersection[axis] = -sign * intersection[3]; // exact homogeneous clipping plane
        output.push(intersection);
      }
    }
    polygon = output;
  }
  if (!polygon.length) return [];
  if (polygon.some((p) => p[3] <= 0)) return undefined;
  const ring: Ring = polygon.map((p) => [
    ((p[0] / p[3] + 1) * width) / 2,
    ((1 - p[1] / p[3]) * height) / 2,
  ]);
  ring.push(ring[0]);
  return ring;
}

const viewport = (width: number, height: number): MultiPolygon => [
  [
    [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
      [0, 0],
    ],
  ],
];
/** Native Style queries accept one simple ring. Triangulate only polygons with
 * holes; no bbox coarsening or bridge edges can invent hits beneath a mask. */
export function exposedRegions(width: number, height: number, mask: MultiPolygon): Ring[] {
  const exposed = mask.length ? difference(viewport(width, height), mask) : viewport(width, height);
  return simpleRegions(exposed);
}
export function simpleRegions(polygons: MultiPolygon): Ring[] {
  return polygons.flatMap((polygon) => {
    if (polygon.length === 1) return [polygon[0]];
    const data = flatten(polygon);
    const indices = earcut(data.vertices, data.holes, data.dimensions);
    const rings: Ring[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      const ring: Ring = indices
        .slice(i, i + 3)
        .map((j) => [data.vertices[j * 2], data.vertices[j * 2 + 1]]);
      ring.push(ring[0]);
      rings.push(ring);
    }
    return rings;
  });
}

export interface NativeCoveragePlan {
  regions: Map<string, Ring[] | undefined>;
  globeMasks?: Map<string, MultiPolygon>;
  limitation?: "no-render-frame" | "terrain-raster" | "invalid-projection" | "invalid-tile-matrix";
}
/** Called synchronously in the render event, sharing the frame's transform,
 * evaluated paint, retained draw coordinates and committed texture generation. */
export function nativeRasterCoverage(map: MapLibreMap, ids: readonly string[]): NativeCoveragePlan {
  const frame = map.painter?.frameRenderContext;
  const regions = new Map<string, Ring[] | undefined>();
  if (!frame) return { regions, limitation: "no-render-frame" };
  if (!ids.length) return { regions };
  const { width, height } = frame.transform;
  let mask: MultiPolygon = [];
  const globeMasks = new Map<string, MultiPolygon>();
  let reference:
    | ReturnType<MapLibreMap["style"]["tileManagers"][string]["getVisibleCoordinates"]>[number]
    | undefined;
  const wanted = new Set(ids);
  let exposure: Ring[] | undefined;
  const layers = map.getStyle()?.layers ?? [];
  let limitation: NativeCoveragePlan["limitation"];
  for (const spec of [...layers].reverse()) {
    if (wanted.has(spec.id)) {
      if (frame.data.useSubdivision) globeMasks.set(spec.id, mask);
      if (
        spec.type === "background" &&
        !frame.terrain &&
        !frame.data.useSubdivision &&
        typeof map.coveringTiles === "function"
      ) {
        const coordinates = map.coveringTiles({ tileSize: frame.transform.tileSize });
        const background = coordinates.length
          ? union(...(coordinates.map(retainedTileDomain) as [MultiPolygon, ...MultiPolygon[]]))
          : [];
        const remaining =
          mask.length && background.length ? difference(background, mask) : background;
        const ref = reference ?? coordinates[0]?.scaledTo(0);
        const projected = ref
          ? projectMercatorMask(
              remaining,
              frame.getProjectionDataForTile(ref, { aligned: !frame.data.moving }).mainMatrix,
              ref.wrap,
              width,
              height,
            )
          : [];
        regions.set(
          spec.id,
          projected?.map((p) => p[0]),
        );
      } else regions.set(spec.id, exposure);
    }
    if (spec.type !== "raster" || !isAttributionLayerVisible(map, spec.id)) continue;
    const layer = map.style.getLayer(spec.id);
    const paint = evaluatedNativePaint(layer?.paint);
    if (layer?.type !== "raster" || paint?.get("raster-opacity") !== 1) continue;
    if (frame.terrain) {
      limitation = "terrain-raster";
      continue;
    }
    const manager = map.style.tileManagers[spec.source];
    if (!manager || manager.getSource().type !== "raster") continue;
    if (frame.data.useSubdivision) {
      const coordinate = manager.getVisibleCoordinates()[0];
      const blend = coordinate && frame.getProjectionDataForTile(coordinate).projectionTransition;
      if (
        coordinate &&
        (blend === undefined || !Number.isFinite(blend) || blend < 0 || blend > 1)
      ) {
        limitation = "invalid-projection";
        continue;
      }
    }
    let occupied: MultiPolygon = [];
    const opaque: MultiPolygon[] = [];
    let level: number | undefined;
    let levelFootprints: MultiPolygon[] = [];
    let levelOpaque: MultiPolygon[] = [];
    const flushLevel = () => {
      if (!levelFootprints.length) return;
      const painted = levelOpaque.length ? union(levelOpaque[0], ...levelOpaque.slice(1)) : [];
      if (painted.length) opaque.push(occupied.length ? difference(painted, occupied) : painted);
      const footprints = union(levelFootprints[0], ...levelFootprints.slice(1));
      occupied = occupied.length ? union(occupied, footprints) : footprints;
      levelFootprints = [];
      levelOpaque = [];
    };
    const fade = paint.get("raster-fade-duration");
    // Same descending overscaledZ priority as renderer depth/stencil overlap.
    for (const coord of [...manager.getVisibleCoordinates()].sort(
      (a, b) => b.overscaledZ - a.overscaledZ,
    )) {
      if (level !== coord.overscaledZ) {
        flushLevel();
        level = coord.overscaledZ;
      }
      const tile = manager.getTile(coord);
      if (!tile?.hasData() || !tile.texture) continue;
      reference ??= coord.scaledTo(0);
      let footprint = retainedTileDomain(coord);
      if (frame.data.useSubdivision) {
        const scale = 2 ** coord.canonical.z;
        const x = coord.wrap + coord.canonical.x / scale,
          d = 1 / scale;
        const y = coord.canonical.y === 0 ? -4 : coord.canonical.y / scale;
        const bottom = coord.canonical.y === scale - 1 ? 5 : (coord.canonical.y + 1) / scale;
        footprint = [
          [
            [
              [x, y],
              [x + d, y],
              [x + d, bottom],
              [x, bottom],
              [x, y],
            ],
          ],
        ];
      }
      levelFootprints.push(footprint);
      const parent =
        fade !== 0 && tile.fadingParentID ? manager.getLoadedTile(tile.fadingParentID) : undefined;
      const weight = fade === 0 ? 1 : parent || tile.selfFading ? tile.fadeOpacity : 1;
      const childOpaque =
        weight === 0 || retainedRasterOpacity(map, spec.source, tile) === "opaque";
      const parentOpaque =
        parent?.texture && retainedRasterOpacity(map, spec.source, parent) === "opaque";
      const isOpaque = parent
        ? childOpaque && (weight === 1 || parentOpaque)
        : weight === 1 && childOpaque;
      if (isOpaque) levelOpaque.push(footprint);
    }
    flushLevel();
    if (reference && opaque.length) {
      mask = union(mask, ...opaque);
      if (frame.data.useSubdivision) continue;
      const projected = projectMercatorMask(
        mask,
        frame.getProjectionDataForTile(reference, { aligned: !frame.data.moving }).mainMatrix,
        reference.wrap,
        width,
        height,
      );
      if (!projected) {
        limitation = "invalid-tile-matrix";
        exposure = undefined;
      } else exposure = exposedRegions(width, height, projected);
    }
  }
  return { regions, limitation, globeMasks };
}
