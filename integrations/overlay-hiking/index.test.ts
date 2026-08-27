import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { overpassQuery } = vi.hoisted(() => ({ overpassQuery: vi.fn() }));

vi.mock("@openmapx/core", async (importActual) => {
  const actual = await importActual<typeof import("@openmapx/core")>();
  return { ...actual, overpassQuery };
});

import {
  createMockIntegrationContext,
  type MockIntegrationContext,
} from "@openmapx/integration-framework/testing";
import { bboxToMercator, latToMercatorY, lngToMercatorX } from "./coord-transform.js";
import { classifyShelterType, setup } from "./index.js";
import { fetchRouteGeometry } from "./overpass-geometry.js";
import { mapSummary } from "./waymarked-trails.js";

function mockOk(data: unknown) {
  return Response.json(data);
}

describe("coord-transform", () => {
  it("projects lng/lat to Web Mercator with antimeridian/equator anchors", () => {
    expect(lngToMercatorX(0)).toBe(0);
    expect(lngToMercatorX(180)).toBeCloseTo(20037508.34, 2);
    expect(lngToMercatorX(-180)).toBeCloseTo(-20037508.34, 2);
    expect(latToMercatorY(0)).toBeCloseTo(0, 6);
  });

  it("bboxToMercator orders output as [minX, minY, maxX, maxY]", () => {
    const [minX, minY, maxX, maxY] = bboxToMercator(45, 5, 47, 8);
    // south=45 west=5 north=47 east=8
    expect(minX).toBeCloseTo(lngToMercatorX(5), 6);
    expect(minY).toBeCloseTo(latToMercatorY(45), 6);
    expect(maxX).toBeCloseTo(lngToMercatorX(8), 6);
    expect(maxY).toBeCloseTo(latToMercatorY(47), 6);
    expect(maxX).toBeGreaterThan(minX);
    expect(maxY).toBeGreaterThan(minY);
  });
});

describe("mapSummary", () => {
  it("renames snake_case waymarked fields and fills defaults", () => {
    expect(
      mapSummary({
        type: "relation",
        id: 42,
        name: "GR 20",
        group: "INT",
        linear: "yes",
        symbol_description: "red/white blaze",
        symbol_id: "gr20",
      }),
    ).toEqual({
      type: "relation",
      id: 42,
      name: "GR 20",
      group: "INT",
      linear: "yes",
      symbolDescription: "red/white blaze",
      symbolId: "gr20",
    });
  });

  it("defaults missing name/group/linear", () => {
    const s = mapSummary({
      type: "relation",
      id: 1,
      name: "",
      group: "",
      linear: "",
      symbol_description: "",
      symbol_id: "",
    });
    expect(s).toMatchObject({ name: "", group: "LOC", linear: "no" });
  });
});

describe("classifyShelterType", () => {
  it.each([
    ["Cabane non gardée", "cabane"],
    ["bivouac", "cabane"],
    ["abri", "cabane"],
    ["Refuge gardé", "refuge"],
    ["gîte d'étape", "gite"],
    ["gite", "gite"],
    ["point d'eau / source", "pt_eau"],
    ["water point", "pt_eau"],
    ["col / passage", "pt_passage"],
    ["mountain hut", "cabane"],
    ["emergency shelter", "cabane"],
    ["something else", "cabane"],
  ])("classifies %s as %s", (raw, expected) => {
    expect(classifyShelterType(raw)).toBe(expected);
  });
});

describe("fetchRouteGeometry", () => {
  beforeEach(() => {
    overpassQuery.mockReset();
  });

  it("turns relation members into [lng,lat] LineStrings and joins way tags by ref", async () => {
    overpassQuery.mockResolvedValueOnce({
      elements: [
        {
          type: "relation",
          id: 100,
          members: [
            {
              type: "way",
              ref: 11,
              role: "",
              geometry: [
                { lat: 45.0, lon: 6.0 },
                { lat: 45.1, lon: 6.1 },
              ],
            },
            // member with <2 points is skipped
            { type: "way", ref: 12, role: "", geometry: [{ lat: 1, lon: 1 }] },
          ],
        },
        {
          type: "way",
          id: 11,
          tags: { sac_scale: "mountain_hiking", surface: "ground", highway: "path" },
        },
      ],
    });

    const fc = await fetchRouteGeometry(100);

    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0];
    // lat/lon swapped to GeoJSON [lon, lat].
    expect(f.geometry.coordinates).toEqual([
      [6.0, 45.0],
      [6.1, 45.1],
    ]);
    expect(f.properties).toEqual({
      sac_scale: "mountain_hiking",
      surface: "ground",
      highway: "path",
    });
  });

  it("emits standalone ways with geometry and empty-string tag fallbacks", async () => {
    overpassQuery.mockResolvedValueOnce({
      elements: [
        {
          type: "way",
          id: 7,
          geometry: [
            { lat: 10, lon: 20 },
            { lat: 11, lon: 21 },
          ],
        },
      ],
    });

    const fc = await fetchRouteGeometry(7);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry.coordinates).toEqual([
      [20, 10],
      [21, 11],
    ]);
    expect(fc.features[0].properties).toEqual({ sac_scale: "", surface: "", highway: "" });
  });
});

describe("/hiking/shelters route", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let ctx: MockIntegrationContext;

  function getRoute(path: string) {
    const route = ctx.registered.routes.find((r) => r.path === path);
    if (!route) throw new Error(`route ${path} not registered`);
    return route.handler;
  }

  function makeReply() {
    const result: { status: number; body: unknown } = { status: 200, body: undefined };
    const reply = {
      send: (data: unknown) => {
        result.body = data;
      },
      status: (code: number) => {
        result.status = code;
        return {
          send: (data: unknown) => {
            result.body = data;
          },
        };
      },
      header: () => {},
      type: () => {},
    };
    return { reply, result };
  }

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    ctx = createMockIntegrationContext();
    setup(ctx);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("maps refuges.info features, normalizing nested type/places objects", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          {
            type: "Feature",
            id: 555,
            properties: {
              nom: "Refuge du Goûter",
              type: { valeur: "refuge gardé" },
              coord: { alt: 3835 },
              places: { valeur: 120 },
            },
            geometry: { type: "Point", coordinates: [6.82, 45.85] },
          },
          {
            type: "Feature",
            id: 556,
            properties: {
              nom: "Cabane libre",
              type: "cabane non gardée",
              coord: { alt: 2000 },
              places: 8,
            },
            geometry: { type: "Point", coordinates: [6.9, 45.9] },
          },
        ],
      }),
    );

    const handler = getRoute("/hiking/shelters");
    const { reply, result } = makeReply();
    await handler(
      {
        query: { south: "45.8", west: "6.8", north: "45.95", east: "6.95" },
        params: {},
        body: undefined,
      },
      reply,
    );

    const body = result.body as {
      type: string;
      features: Array<{ geometry: unknown; properties: Record<string, unknown> }>;
    };
    expect(result.status).toBe(200);
    expect(body.type).toBe("FeatureCollection");
    expect(body.features).toHaveLength(2);
    expect(body.features[0].geometry).toEqual({ type: "Point", coordinates: [6.82, 45.85] });
    expect(body.features[0].properties).toEqual({
      id: 555,
      name: "Refuge du Goûter",
      type: "refuge",
      altitude: 3835,
      capacity: 120,
    });
    expect(body.features[1].properties).toMatchObject({
      type: "cabane",
      altitude: 2000,
      capacity: 8,
    });
  });

  it("rejects an over-large bounding box with 400", async () => {
    const handler = getRoute("/hiking/shelters");
    const { reply, result } = makeReply();
    await handler(
      { query: { south: "40", west: "0", north: "45", east: "10" }, params: {}, body: undefined },
      reply,
    );
    expect(result.status).toBe(400);
  });
});
