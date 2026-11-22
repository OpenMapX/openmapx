import type { ManeuverLane } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import type { DecodedTile, TileFeature } from "../web/derive/decode";
import { type LaneHighlightInput, laneHighlight } from "../web/derive/lane-highlight";

const EXTENT = 4096;
const N = 2 ** 16;
const R = 6371008.8;

function tileOf(lng: number, lat: number) {
  const x = Math.floor(((lng + 180) / 360) * N);
  const s = Math.sin((lat * Math.PI) / 180);
  const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * N);
  return { x, y };
}
function tileCentre(x: number, y: number): [number, number] {
  const lng = ((x + 0.5) / N) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / N))) * 180) / Math.PI;
  return [lng, lat];
}

/** A scene around a z16 tile's centre: metres east/north of it → lng/lat and tile units. */
function scene(lng: number, lat: number) {
  const { x, y } = tileOf(lng, lat);
  const centre = tileCentre(x, y);
  const k = (Math.PI / 180) * R;
  const cos = Math.cos((centre[1] * Math.PI) / 180);
  const lngLat = (e: number, n: number): [number, number] => [
    centre[0] + e / (k * cos),
    centre[1] + n / k,
  ];
  const units = (e: number, n: number): [number, number] => {
    const [plng, plat] = lngLat(e, n);
    const s = Math.sin((plat * Math.PI) / 180);
    const tx = ((plng + 180) / 360) * N;
    const ty = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * N;
    return [(tx - x) * EXTENT, (ty - y) * EXTENT];
  };
  const road = (
    id: number | undefined,
    props: TileFeature["props"],
    ...points: [number, number][]
  ): TileFeature => ({
    type: 2,
    geometry: [points.map(([e, n]) => units(e, n))],
    props: { oneway: 0, layer: 0, ...props },
    ...(id === undefined ? {} : { id: id * 10 + 2 }),
  });
  const tiles = (...roads: TileFeature[]) => [
    { z: 16 as const, x, y, tile: { extent: EXTENT, layers: { roads } } as DecodedTile },
  ];
  // The route arrives eastbound along y = 0 and turns at the scene centre.
  const approach = Array.from({ length: 16 }, (_, i) => lngLat(-150 + i * 10, 0));
  return { lngLat, road, tiles, approach };
}

const engine = (...lanes: string[][]): ManeuverLane[] =>
  lanes.map((indications) => ({ indications, valid: true }));

const berlin = scene(13.4, 52.52);
const CROSSING = berlin.road(900, { class: "primary" }, [0, -100], [0, 0], [0, 100]);
const WAY = 1234;

function input(overrides: Partial<LaneHighlightInput> = {}): LaneHighlightInput {
  return {
    tiles: berlin.tiles(
      berlin.road(
        WAY,
        { class: "primary", lanes: 4, lanes_fw: 2, lanes_bw: 2, turn_fw: "left|through;right" },
        [-180, 0],
        [0, 0],
      ),
      CROSSING,
    ),
    wayId: WAY,
    approach: berlin.approach,
    engineLanes: engine(["left"], ["through", "right"]),
    recommended: [1],
    classes: ["urban", "motorway"],
    ...overrides,
  };
}

/** Mean latitude of a polygon's ring, against the road's latitude (0 m north). */
const northOfRoad = (ring: [number, number][], lat0: number) =>
  ring.reduce((sum, p) => sum + p[1], 0) / ring.length - lat0;

describe("laneHighlight", () => {
  it("draws the recommended lanes of an agreeing approach", () => {
    const answer = laneHighlight(input());
    expect(answer.polygons).toHaveLength(1);
    if (!answer.polygons) return;
    // Eastbound traffic keeps right: the lane lies south of the centre line.
    expect(
      northOfRoad(answer.polygons[0] as [number, number][], berlin.lngLat(0, 0)[1]),
    ).toBeLessThan(0);
    // The crossing primary is 6.5 m wide: the junction starts 3.25 + 1 m back.
    expect("endBeforeManeuver" in answer && answer.endBeforeManeuver).toBeCloseTo(4.25, 1);
    expect("startBeforeManeuver" in answer && answer.startBeforeManeuver).toBeGreaterThan(120);
  });

  it("no polygons when indications disagree", () => {
    expect(laneHighlight(input({ engineLanes: engine(["left"], ["right"]) }))).toEqual({
      polygons: null,
      reason: "indications",
    });
  });

  it("no polygons on a two-way road with a bare turn:lanes", () => {
    const tiles = berlin.tiles(
      berlin.road(
        WAY,
        { class: "primary", lanes: 4, lanes_fw: 2, lanes_bw: 2, turn: "left|through;right" },
        [-180, 0],
        [0, 0],
      ),
      CROSSING,
    );
    expect(laneHighlight(input({ tiles }))).toEqual({ polygons: null, reason: "turn-missing" });
  });

  it("uses turn:lanes:backward against the digitised direction", () => {
    const tiles = berlin.tiles(
      berlin.road(
        WAY,
        { class: "primary", lanes: 4, lanes_fw: 2, lanes_bw: 2, turn_bw: "left|through;right" },
        [0, 0],
        [-180, 0],
      ),
      CROSSING,
    );
    const answer = laneHighlight(input({ tiles }));
    expect(answer.polygons).toHaveLength(1);
    if (!answer.polygons) return;
    expect(
      northOfRoad(answer.polygons[0] as [number, number][], berlin.lngLat(0, 0)[1]),
    ).toBeLessThan(0);
  });

  it("left-hand traffic mirrors lane order", () => {
    const london = scene(-0.12, 51.5);
    const answer = laneHighlight({
      tiles: london.tiles(
        london.road(
          WAY,
          { class: "primary", lanes: 4, lanes_fw: 2, lanes_bw: 2, turn_fw: "left|through;right" },
          [-180, 0],
          [0, 0],
        ),
        london.road(900, { class: "primary" }, [0, -100], [0, 0], [0, 100]),
      ),
      wayId: WAY,
      approach: london.approach,
      engineLanes: engine(["left"], ["through", "right"]),
      recommended: [1],
      classes: ["urban"],
    });
    expect(answer.polygons).toHaveLength(1);
    if (!answer.polygons) return;
    // Eastbound traffic keeps left: its lanes lie north of the centre line.
    expect(
      northOfRoad(answer.polygons[0] as [number, number][], london.lngLat(0, 0)[1]),
    ).toBeGreaterThan(0);
  });

  it("stops at the way start", () => {
    const tiles = berlin.tiles(
      berlin.road(
        WAY,
        { class: "primary", lanes: 4, lanes_fw: 2, lanes_bw: 2, turn_fw: "left|through;right" },
        [-60, 0],
        [0, 0],
      ),
      berlin.road(77, { class: "primary" }, [-180, 0], [-60, 0]),
      CROSSING,
    );
    const answer = laneHighlight(input({ tiles }));
    expect(answer.polygons).toHaveLength(1);
    expect("startBeforeManeuver" in answer && answer.startBeforeManeuver).toBeLessThanOrEqual(64);
  });

  it("a tile without ids gives no match", () => {
    const tiles = berlin.tiles(
      berlin.road(
        undefined,
        { class: "primary", lanes: 4, lanes_fw: 2, lanes_bw: 2, turn_fw: "left|through;right" },
        [-180, 0],
        [0, 0],
      ),
    );
    expect(laneHighlight(input({ tiles }))).toEqual({ polygons: null, reason: "no-ids" });
  });

  it("an excluded class gives no match", () => {
    expect(laneHighlight(input({ classes: ["motorway"] }))).toEqual({
      polygons: null,
      reason: "class-excluded",
    });
  });
});
