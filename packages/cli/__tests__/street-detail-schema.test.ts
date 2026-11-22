import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { STREET_DETAIL_LAYERS, STREET_DETAIL_SCHEMA } from "../src/lib/street-detail-schema";

interface Attribute {
  key: string;
  type?: string;
  tag_value?: string;
  value?: unknown;
  coalesce?: Array<{ tag_value: string }>;
}
interface Feature {
  source?: string;
  geometry: string;
  include_when?: unknown;
  exclude_when?: unknown;
  attributes: Attribute[];
}
interface Layer {
  id: string;
  buffer: number;
  features: Feature[];
}
interface Example {
  name: string;
  input: { geometry: string; tags: Record<string, string> };
  output: Array<{ layer: string; tags?: Record<string, unknown> }>;
}
interface Schema {
  attribution: string;
  args: Record<string, unknown>;
  sources: Record<string, Record<string, unknown>>;
  layers: Layer[];
  examples: Example[];
}

const schema = parse(STREET_DETAIL_SCHEMA) as Schema;
const layer = (id: string) => schema.layers.find((entry) => entry.id === id) as Layer;
const attributes = (id: string) =>
  Object.fromEntries(
    layer(id).features.flatMap((feature) =>
      feature.attributes.map((attribute) => [attribute.key, attribute] as const),
    ),
  );

const EXPECTED_TYPES: Record<string, Record<string, string>> = {
  roads: {
    class: "string",
    oneway: "integer",
    junction: "string",
    lanes: "integer",
    lanes_fw: "integer",
    lanes_bw: "integer",
    width: "double",
    lane_markings: "string",
    turn: "string",
    turn_fw: "string",
    turn_bw: "string",
    cycle: "string",
    cycle_l: "string",
    cycle_r: "string",
    cycle_both: "string",
    cycle_lane_l: "string",
    cycle_lane_r: "string",
    cycle_lane_both: "string",
    busway: "string",
    busway_l: "string",
    busway_r: "string",
    busway_both: "string",
    bus_lanes: "string",
    bus_lanes_fw: "string",
    bus_lanes_bw: "string",
    lanes_bus: "integer",
    bridge: "boolean",
    layer: "integer",
  },
  rails: { kind: "string", bridge: "boolean", layer: "integer", embedded: "string" },
  crossings: { markings: "string", crossing: "string", crossing_ref: "string" },
  trees: { height: "double", crown: "double", circ: "double", leaf: "string", genus: "string" },
  furniture: {
    kind: "string",
    dir: "string",
    sig_dir: "string",
    stop_dir: "string",
    stop: "string",
    mount: "string",
    backrest: "boolean",
  },
  pitches: { sport: "string", surface: "string" },
};

describe("street detail schema", () => {
  it("builds z16 only, without simplification or size filtering", () => {
    expect(schema.args).toMatchObject({
      minzoom: 16,
      maxzoom: 16,
      simplify_tolerance_at_max_zoom: 0,
      min_feature_size_at_max_zoom: 0,
    });
    expect(schema.attribution).toContain("OpenStreetMap");
  });

  it("furniture carries stop and give_way with stop_dir and stop", () => {
    const furniture = schema.layers.find((entry) => entry.id === "furniture");
    const feature = furniture?.features[0] as unknown as {
      include_when: { highway: string[] };
      attributes: { key: string; value?: Record<string, unknown> }[];
    };
    expect(feature.include_when.highway).toEqual([
      "street_lamp",
      "traffic_signals",
      "stop",
      "give_way",
    ]);
    const kind = feature.attributes.find((attribute) => attribute.key === "kind")?.value;
    expect(kind?.stop).toEqual({ highway: "stop" });
    expect(kind?.give_way).toEqual({ highway: "give_way" });
    expect(STREET_DETAIL_SCHEMA).toContain("name: stop sign");
    expect(STREET_DETAIL_SCHEMA).toContain("name: give way sign");
  });

  it("roads layer has no tile_post_process merge", () => {
    // The lane highlight reads each road's OSM way id from Planetiler's feature
    // id (osmId × 10 + 2); merging lines would drop it.
    const roads = schema.layers.find((entry) => entry.id === "roads") as Record<string, unknown>;
    expect(roads.tile_post_process).toBeUndefined();
    expect(STREET_DETAIL_SCHEMA).not.toContain("tile_post_process");
  });

  it("reads the local extract and never downloads", () => {
    expect(schema.sources).toEqual({ osm: { type: "osm", local_path: "/osm/input.osm.pbf" } });
  });

  it("emits the six layers with their buffers", () => {
    expect(schema.layers.map((entry) => entry.id)).toEqual([...STREET_DETAIL_LAYERS]);
    expect(schema.layers.map((entry) => entry.buffer)).toEqual([32, 32, 8, 8, 8, 96]);
    for (const entry of schema.layers)
      for (const feature of entry.features) expect(feature.source).toBe("osm");
  });

  it.each(Object.keys(EXPECTED_TYPES))("types every %s attribute", (id) => {
    const found = attributes(id);
    for (const [key, type] of Object.entries(EXPECTED_TYPES[id] as Record<string, string>))
      expect(found[key]?.type, `${id}.${key}`).toBe(type);
    expect(Object.keys(found).sort()).toEqual(
      Object.keys(EXPECTED_TYPES[id] as Record<string, string>).sort(),
    );
  });

  it("derives oneway from the tag, roundabouts and motorways in that order", () => {
    const oneway = attributes("roads").oneway as Attribute;
    expect(oneway.value).toEqual([
      { if: { oneway: ["yes", "1", "true"] }, value: 1 },
      { if: { oneway: "-1" }, value: -1 },
      { if: { oneway: "no" }, value: 0 },
      { if: { junction: ["roundabout", "circular"] }, value: 1 },
      { if: { highway: ["motorway", "motorway_link"] }, value: 1 },
      { else: 0 },
    ]);
  });

  it("excludes areas, tunnels, covered and underground roads and private service ways", () => {
    const exclusions = JSON.stringify(layer("roads").features[0]?.exclude_when);
    expect(exclusions).toContain('{"area":"yes"}');
    expect(exclusions).toContain('{"covered":"yes"}');
    expect(exclusions).toContain('{"layer":"-%"}');
    expect(exclusions).toContain('{"__all__":[{"tunnel":"__any__"},{"__not__":{"tunnel":"no"}}]}');
    expect(exclusions).toContain(
      '{"__all__":[{"highway":"service"},{"service":["driveway","parking_aisle","drive-through"]}]}',
    );
    for (const feature of layer("roads").features)
      expect(feature.exclude_when).toEqual(layer("roads").features[0]?.exclude_when);
  });

  it("keeps paths only on bridges", () => {
    const paths = layer("roads").features[1] as Feature;
    expect(JSON.stringify(paths.include_when)).toContain(
      '{"highway":["footway","path","cycleway","pedestrian","steps"]}',
    );
    expect(JSON.stringify(paths.include_when)).toContain('{"bridge":"__any__"}');
    expect(JSON.stringify(paths.include_when)).toContain('{"__not__":{"bridge":"no"}}');
  });

  it("coalesces bus lanes with public service vehicle lanes", () => {
    const found = attributes("roads");
    expect(found.bus_lanes?.coalesce).toEqual([
      { tag_value: "bus:lanes" },
      { tag_value: "psv:lanes" },
    ]);
    expect(found.bus_lanes_fw?.coalesce).toEqual([
      { tag_value: "bus:lanes:forward" },
      { tag_value: "psv:lanes:forward" },
    ]);
    expect(found.bus_lanes_bw?.coalesce).toEqual([
      { tag_value: "bus:lanes:backward" },
      { tag_value: "psv:lanes:backward" },
    ]);
  });

  it("carries examples for every layer and the oneway and exclusion cases", () => {
    const layers = new Set(schema.examples.flatMap((e) => e.output.map((o) => o.layer)));
    for (const id of STREET_DETAIL_LAYERS) expect(layers).toContain(id);
    const names = schema.examples.map((example) => example.name).join("\n");
    for (const name of ["oneway=-1", "motorway", "roundabout", "tunnel", "negative layer"])
      expect(names).toContain(name);
    const excluded = schema.examples.filter((example) => example.output.length === 0);
    expect(excluded.map((example) => example.name).join("\n")).toMatch(/tunnel/);
    expect(excluded.map((example) => example.name).join("\n")).toMatch(/negative layer/);
  });
});
