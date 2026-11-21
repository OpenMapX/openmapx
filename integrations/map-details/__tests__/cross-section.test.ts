import { describe, expect, it } from "vitest";
import type { TileFeature } from "../web/derive/decode";
import { ringArea } from "../web/derive/geometry";
import { type CrossSection, crossSection, roadSurfaces } from "../web/derive/roads";

type Props = Record<string, string | number | boolean>;
const road = (props: Props) => crossSection({ oneway: 0, layer: 0, ...props }, false);
const kinds = (section: CrossSection) => section.lanes.map((lane) => `${lane.kind}:${lane.dir}`);
const widths = (section: CrossSection) => section.lanes.map((lane) => lane.width);

describe("cross-section lane counts", () => {
  it("uses mapped per-direction counts first", () => {
    const section = road({ class: "primary", lanes: 5, lanes_fw: 3, lanes_bw: 1 });
    expect(kinds(section)).toEqual(["general:bw", "general:fw", "general:fw", "general:fw"]);
  });

  it("fills the other direction from the total when only one is mapped", () => {
    expect(kinds(road({ class: "primary", lanes: 3, lanes_fw: 2 }))).toEqual([
      "general:bw",
      "general:fw",
      "general:fw",
    ]);
  });

  it("splits a mapped total with the odd lane forward", () => {
    expect(kinds(road({ class: "secondary", lanes: 3 }))).toEqual([
      "general:bw",
      "general:fw",
      "general:fw",
    ]);
  });

  it("puts every mapped lane forward on a one-way road", () => {
    expect(kinds(road({ class: "primary", lanes: 3, oneway: 1 }))).toEqual([
      "general:fw",
      "general:fw",
      "general:fw",
    ]);
  });

  it.each([
    ["motorway", 0, 4],
    ["trunk", 0, 4],
    ["motorway_link", 1, 1],
    ["primary", 0, 2],
    ["tertiary_link", 0, 2],
    ["residential", 0, 2],
    ["living_street", 0, 2],
    ["service", 0, 1],
    ["busway", 0, 2],
  ])("falls back to class defaults for %s", (cls, oneway, count) => {
    expect(road({ class: cls, oneway }).lanes).toHaveLength(count);
  });

  it("ignores out-of-range counts", () => {
    expect(road({ class: "primary", lanes: 12 }).lanes).toHaveLength(2);
  });
});

describe("cross-section direction", () => {
  it("reverses oneway=-1 and treats every lane as forward", () => {
    const section = road({ class: "primary", oneway: -1, lanes: 2 });
    expect(section.reversed).toBe(true);
    expect(section.oneway).toBe(true);
    expect(kinds(section)).toEqual(["general:fw", "general:fw"]);
  });

  it("treats an untagged motorway (oneway 1 from the schema) as forward only", () => {
    const section = road({ class: "motorway", oneway: 1 });
    expect(kinds(section)).toEqual(["general:fw", "general:fw"]);
    expect(section.reversed).toBe(false);
  });

  it("puts backward lanes on the right in left-hand traffic", () => {
    const section = crossSection({ class: "primary", oneway: 0, lanes: 2 }, true);
    expect(kinds(section)).toEqual(["general:fw", "general:bw"]);
  });
});

describe("lane markings", () => {
  it.each<[Props, boolean]>([
    [{ class: "primary", lanes: 2 }, true],
    [{ class: "primary" }, false],
    [{ class: "primary", lanes: 2, lane_markings: "no" }, false],
    [{ class: "residential", lanes: 2 }, false],
    [{ class: "residential", lanes: 2, lane_markings: "yes" }, true],
    [{ class: "residential", lanes: 2, turn_fw: "left|through" }, true],
    [{ class: "service", lanes: 1, oneway: 1, turn: "through" }, true],
  ])("marks %j: %s", (props, marked) => {
    expect(road(props).marked).toBe(marked);
  });
});

describe("bus lanes", () => {
  it("reads designated lanes from bus:lanes on a one-way road", () => {
    const section = road({
      class: "primary",
      oneway: 1,
      lanes: 3,
      bus_lanes: "|designated|designated",
    });
    expect(kinds(section)).toEqual(["general:fw", "bus:fw", "bus:fw"]);
    expect(widths(section)).toEqual([3.25, 3.25, 3.25]);
  });

  it("reads per-direction bus lanes and reverses the backward list", () => {
    const section = road({
      class: "primary",
      lanes_fw: 2,
      lanes_bw: 2,
      bus_lanes_fw: "|designated",
      bus_lanes_bw: "|designated",
    });
    expect(kinds(section)).toEqual(["bus:bw", "general:bw", "general:fw", "bus:fw"]);
  });

  it("ignores a bus lane list of the wrong length", () => {
    expect(kinds(road({ class: "primary", oneway: 1, lanes: 2, bus_lanes: "designated" }))).toEqual(
      ["general:fw", "general:fw"],
    );
  });

  it("turns the outermost lane of a side into a bus lane for busway:right=lane", () => {
    expect(kinds(road({ class: "primary", lanes: 4, busway_r: "lane" }))).toEqual([
      "general:bw",
      "general:bw",
      "general:fw",
      "bus:fw",
    ]);
  });

  it("adds a bus lane when the lane count is not mapped", () => {
    expect(kinds(road({ class: "primary", busway_r: "lane" }))).toEqual([
      "general:bw",
      "general:fw",
      "bus:fw",
    ]);
  });

  it("turns the outermost forward lanes into bus lanes for lanes:bus", () => {
    expect(kinds(road({ class: "primary", oneway: 1, lanes: 3, lanes_bus: 1 }))).toEqual([
      "general:fw",
      "general:fw",
      "bus:fw",
    ]);
  });

  it("makes a busway a bus lane across its whole width", () => {
    expect(kinds(road({ class: "busway" }))).toEqual(["bus:bw", "bus:fw"]);
  });
});

describe("cycle lanes", () => {
  it("adds strips at each mapped side, outside any bus lane", () => {
    const section = road({
      class: "primary",
      lanes: 4,
      busway_r: "lane",
      cycle_r: "lane",
      cycle_l: "lane",
    });
    expect(kinds(section)).toEqual([
      "cycle:bw",
      "general:bw",
      "general:bw",
      "general:fw",
      "bus:fw",
      "cycle:fw",
    ]);
    expect(widths(section)[0]).toBe(1.5);
  });

  it("puts cycleway=lane on both sides of a two-way road", () => {
    expect(kinds(road({ class: "residential", cycle: "lane" }))).toEqual([
      "cycle:bw",
      "general:bw",
      "general:fw",
      "cycle:fw",
    ]);
  });

  it("puts cycleway=lane at the kerb of a one-way road", () => {
    expect(kinds(road({ class: "residential", oneway: 1, cycle: "lane" }))).toEqual([
      "general:fw",
      "cycle:fw",
    ]);
    expect(
      kinds(crossSection({ class: "residential", oneway: 1, cycle: "lane", layer: 0 }, true)),
    ).toEqual(["cycle:fw", "general:fw"]);
  });

  it("puts an opposite lane on the left of a one-way road, right in left-hand traffic", () => {
    expect(kinds(road({ class: "residential", oneway: 1, cycle: "opposite_lane" }))).toEqual([
      "cycle:bw",
      "general:fw",
    ]);
    expect(
      kinds(
        crossSection({ class: "residential", oneway: 1, cycle: "opposite_lane", layer: 0 }, true),
      ),
    ).toEqual(["general:fw", "cycle:bw"]);
  });

  it("swaps explicit sides of a reversed one-way road", () => {
    expect(kinds(road({ class: "residential", oneway: -1, cycle_r: "lane" }))).toEqual([
      "cycle:fw",
      "general:fw",
    ]);
  });

  it("does not draw tracks", () => {
    expect(kinds(road({ class: "residential", cycle: "track" }))).toEqual([
      "general:bw",
      "general:fw",
    ]);
  });
});

describe("widths and offsets", () => {
  it.each([
    ["motorway", 3.5],
    ["trunk_link", 3.5],
    ["primary", 3.25],
    ["secondary", 3.25],
    ["tertiary", 3],
    ["service", 3],
    ["residential", 2.75],
    ["unclassified", 2.75],
  ])("uses %s lanes of %f m", (cls, width) => {
    expect(road({ class: cls }).lanes[0]?.width).toBe(width);
  });

  it("centres the cross-section on the line, offsets positive to the right", () => {
    const section = road({ class: "primary", lanes: 2 });
    expect(section.width).toBe(6.5);
    expect(section.lanes.map((lane) => lane.offset)).toEqual([-1.625, 1.625]);
  });

  it("scales the whole cross-section to a mapped width", () => {
    const section = road({ class: "primary", lanes: 2, width: 13, cycle_r: "lane" });
    expect(section.width).toBeCloseTo(13, 9);
    const natural = 3.25 + 3.25 + 1.5;
    expect(section.lanes[2]?.width).toBeCloseTo((1.5 * 13) / natural, 9);
  });

  it("ignores implausible mapped widths", () => {
    expect(road({ class: "primary", lanes: 2, width: 90 }).width).toBe(6.5);
  });

  it("carries turn lists onto their lanes", () => {
    const section = road({
      class: "primary",
      lanes_fw: 2,
      lanes_bw: 2,
      turn_fw: "left|through;right",
      turn_bw: "left|through",
    });
    expect(section.lanes.map((lane) => lane.turn)).toEqual([
      ["through"],
      ["left"],
      ["left"],
      ["through", "right"],
    ]);
  });
});

describe("road surfaces", () => {
  const MPU = 0.1;
  const line = (props: Props, points: [number, number][]): TileFeature => ({
    type: 2,
    geometry: [points.map(([x, y]) => [x / MPU, y / MPU] as [number, number])],
    props: { oneway: 0, layer: 0, ...props },
  });

  it("buffers a 50 m road to its real width", () => {
    const [surface] = roadSurfaces(
      [
        line({ class: "primary", lanes: 2 }, [
          [10, 10],
          [60, 10],
        ]),
      ],
      MPU,
      false,
    );
    const area = (surface?.rings ?? []).reduce((sum, ring) => sum + Math.abs(ringArea(ring)), 0);
    expect(Math.abs(area - 50 * 6.5) / (50 * 6.5)).toBeLessThan(0.01);
    expect(surface?.kind).toBe("surface");
  });

  it("colours motorways and trunks as major roads and keeps their layer", () => {
    const [surface] = roadSurfaces(
      [
        line({ class: "trunk", layer: 1 }, [
          [0, 0],
          [10, 0],
        ]),
      ],
      MPU,
      false,
    );
    expect(surface).toMatchObject({ kind: "surface_major", layer: 1 });
  });

  it("leaves bridge paths to the rail and bridge pass", () => {
    expect(
      roadSurfaces(
        [
          line({ class: "footway", bridge: true }, [
            [0, 0],
            [10, 0],
          ]),
        ],
        MPU,
        false,
      ),
    ).toEqual([]);
  });
});
