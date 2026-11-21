import type { TileFeature } from "./decode";
import { bufferPolyline, offsetPolyline, type Ring } from "./geometry";
import { isMotorRoad, layerOf, linesInMetres, type PaintKind, type PaintPolygon } from "./roads";

/** Rails and bridge paths (spec §5.6). Metres in the tile frame. */

const STANDARD_GAUGE_M = 1.435;
const NARROW_GAUGE_M = 1;
const RAIL_HALF_WIDTH_M = 0.05;
const BAND_HALF_WIDTH_M = 1.3;
const BRIDGE_HALF_WIDTH_M = 1.5;
const BRIDGE_EDGE_HALF_WIDTH_M = 0.15;

function collect(out: PaintPolygon[], layer: number, kind: PaintKind, rings: Ring[]) {
  if (rings.length > 0) out.push({ kind, layer, rings });
}

/**
 * Two rails on a track band (only the rails for embedded tram tracks), and
 * bridge paths as a 3 m deck with an edge on each side, all on their own
 * layer so a bridge sorts above the street it crosses.
 */
export function railPaint(rails: TileFeature[], roads: TileFeature[], mpu: number): PaintPolygon[] {
  const out: PaintPolygon[] = [];
  for (const rail of rails) {
    if (rail.type !== 2) continue;
    const gauge = rail.props.kind === "narrow_gauge" ? NARROW_GAUGE_M : STANDARD_GAUGE_M;
    const embedded = typeof rail.props.embedded === "string" && rail.props.embedded !== "no";
    const lines = linesInMetres(rail, mpu);
    const layer = layerOf(rail.props);
    if (!embedded)
      collect(
        out,
        layer,
        "rail_band",
        lines.flatMap((line) => bufferPolyline(line, BAND_HALF_WIDTH_M)),
      );
    collect(
      out,
      layer,
      "rail",
      lines.flatMap((line) =>
        [-gauge / 2, gauge / 2].flatMap((offset) =>
          bufferPolyline(offsetPolyline(line, offset), RAIL_HALF_WIDTH_M),
        ),
      ),
    );
  }
  for (const road of roads) {
    if (road.type !== 2 || isMotorRoad(road.props) || road.props.bridge !== true) continue;
    const lines = linesInMetres(road, mpu);
    const layer = layerOf(road.props);
    collect(
      out,
      layer,
      "path_bridge",
      lines.flatMap((line) => bufferPolyline(line, BRIDGE_HALF_WIDTH_M)),
    );
    const edge = BRIDGE_HALF_WIDTH_M + BRIDGE_EDGE_HALF_WIDTH_M;
    collect(
      out,
      layer,
      "path_bridge_edge",
      lines.flatMap((line) =>
        [-edge, edge].flatMap((offset) =>
          bufferPolyline(offsetPolyline(line, offset), BRIDGE_EDGE_HALF_WIDTH_M),
        ),
      ),
    );
  }
  return out;
}
