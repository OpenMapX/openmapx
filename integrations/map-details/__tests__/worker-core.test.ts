import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { describe, expect, it, vi } from "vitest";
import { type Pt, ringArea } from "../web/derive/geometry";
import type { PaintPolygon } from "../web/derive/roads";
import {
  createWorkerCore,
  encodePaintTile,
  type WorkerRequest,
  type WorkerResponse,
} from "../web/worker-core";
import { ALEXANDERPLATZ, fixtureBytes, fixtureTile } from "./fixtures";

const TEMPLATE = "https://maps.example/tiles/data/street_detail/{z}/{x}/{y}.pbf";
const BASEMAP = "https://tiles.example/{z}/{x}/{y}.pbf";
const { x: X, y: Y } = fixtureTile(ALEXANDERPLATZ);
const STREET_URL = `https://maps.example/tiles/data/street_detail/16/${X}/${Y}.pbf`;

function fakeFetch(extra: Record<string, () => Promise<Response>> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (extra[url]) return extra[url]();
    if (url === STREET_URL) return new Response(fixtureBytes(ALEXANDERPLATZ));
    return new Response(null, { status: 404 });
  });
}

function decodePaint(bytes: ArrayBuffer | null) {
  expect(bytes).not.toBeNull();
  const tile = new VectorTile(new PbfReader(new Uint8Array(bytes as ArrayBuffer)));
  expect(Object.keys(tile.layers)).toEqual(["paint"]);
  const layer = tile.layers.paint;
  if (!layer) throw new Error("no paint layer");
  return Array.from({ length: layer.length }, (_, i) => layer.feature(i)).map((feature) => ({
    props: feature.properties,
    rings: feature.loadGeometry(),
    extent: layer.extent,
  }));
}

/** A core whose answers to non-cancel requests are never null. */
function coreWith(fetchImpl: ReturnType<typeof fakeFetch>) {
  const core = createWorkerCore(fetchImpl as unknown as typeof fetch);
  return {
    cancel: (target: number) => core.handle({ id: 0, kind: "cancel", target }),
    async handle(request: Exclude<WorkerRequest, { kind: "cancel" }>) {
      const result = await core.handle(request);
      if (!result) throw new Error("no answer");
      return result;
    },
  };
}

const paintBytes = (response: WorkerResponse) =>
  "kind" in response && response.kind === "paint" ? response.bytes : undefined;

describe("worker core paint", () => {
  it("encodes a z16 tile as one paint layer with kind and layer", async () => {
    const core = coreWith(fakeFetch());
    const { response, transfer } = await core.handle({
      id: 1,
      kind: "paint",
      z: 16,
      x: X,
      y: Y,
      streetTemplate: TEMPLATE,
    });
    const features = decodePaint(paintBytes(response) ?? null);
    // One feature per kind and layer.
    expect(features.length).toBeGreaterThan(3);
    const kinds = new Set(features.map((f) => f.props.kind));
    for (const kind of ["surface", "rail", "marking"]) expect(kinds).toContain(kind);
    expect(features.every((f) => typeof f.props.layer === "number")).toBe(true);
    expect(features[0]?.extent).toBe(8192);
    expect(transfer).toHaveLength(1);
  });

  it("derives the z16 parent once for its children and keeps each child's geometry in its square", async () => {
    const fetchImpl = fakeFetch();
    const core = coreWith(fetchImpl);
    for (const [z, dx, dy] of [
      [17, 0, 0],
      [17, 1, 1],
      [18, 3, 2],
    ] as const) {
      const f = 2 ** (z - 16);
      const { response } = await core.handle({
        id: 2,
        kind: "paint",
        z,
        x: X * f + dx,
        y: Y * f + dy,
        streetTemplate: TEMPLATE,
      });
      const features = decodePaint(paintBytes(response) ?? null);
      expect(features.length).toBeGreaterThan(0);
      for (const feature of features)
        for (const ring of feature.rings)
          for (const p of ring) {
            expect(p.x).toBeGreaterThanOrEqual(-64);
            expect(p.x).toBeLessThanOrEqual(8192 + 64);
            expect(p.y).toBeGreaterThanOrEqual(-64);
            expect(p.y).toBeLessThanOrEqual(8192 + 64);
          }
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("answers null for a missing street tile", async () => {
    const core = coreWith(fakeFetch());
    const { response } = await core.handle({
      id: 3,
      kind: "paint",
      z: 16,
      x: 1,
      y: 1,
      streetTemplate: TEMPLATE,
    });
    expect(response).toEqual({ id: 3, kind: "paint", bytes: null });
  });

  it("stops a cancelled request before deriving", async () => {
    let release: (r: Response) => void = () => {};
    const fetchImpl = fakeFetch({
      [STREET_URL]: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    const core = coreWith(fetchImpl);
    const pending = core.handle({
      id: 4,
      kind: "paint",
      z: 16,
      x: X,
      y: Y,
      streetTemplate: TEMPLATE,
    });
    await core.cancel(4);
    release(new Response(fixtureBytes(ALEXANDERPLATZ)));
    expect((await pending).response).toEqual({ id: 4, error: "cancelled" });
  });
});

describe("worker core objects", () => {
  it("serves paint and objects for one tile from a single street fetch", async () => {
    const fetchImpl = fakeFetch();
    const core = coreWith(fetchImpl);
    const paint = await core.handle({
      id: 6,
      kind: "paint",
      z: 16,
      x: X,
      y: Y,
      streetTemplate: TEMPLATE,
    });
    const request = {
      id: 7,
      kind: "objects" as const,
      cellX: X,
      cellY: Y,
      streetTemplate: TEMPLATE,
      basemapTemplates: [BASEMAP],
      basemapMaxzoom: 14,
    };
    const objects = await core.handle(request);
    const again = await core.handle({ ...request, id: 8 });
    const instances = (r: WorkerResponse) =>
      "kind" in r && r.kind === "objects" ? r.instances : [];
    expect(decodePaint(paintBytes(paint.response) ?? null).length).toBeGreaterThan(0);
    expect(instances(objects.response).reduce((s, set) => s + set.count, 0)).toBeGreaterThan(10);
    // A cached cell is served again intact: transfers never detach the cache.
    expect(instances(again.response)).toEqual(instances(objects.response));
    const streetCalls = fetchImpl.mock.calls.filter(([url]) => String(url) === STREET_URL);
    expect(streetCalls).toHaveLength(1);
  });
});

describe("worker core objects with a failing basemap", () => {
  it("still places street objects when the basemap tile fails", async () => {
    const fetchImpl = fakeFetch({
      [`https://tiles.example/14/${Math.floor(X / 4)}/${Math.floor(Y / 4)}.pbf`]: async () =>
        new Response(null, { status: 500 }),
    });
    const core = coreWith(fetchImpl);
    const { response } = await core.handle({
      id: 9,
      kind: "objects",
      cellX: X,
      cellY: Y,
      streetTemplate: TEMPLATE,
      basemapTemplates: [BASEMAP],
      basemapMaxzoom: 14,
    });
    expect("kind" in response && response.kind).toBe("objects");
    const instances = "kind" in response && response.kind === "objects" ? response.instances : [];
    expect(instances.reduce((sum, set) => sum + set.count, 0)).toBeGreaterThan(10);
  });
});

describe("worker core lane highlight", () => {
  const centre = (): [number, number] => {
    const n = 2 ** 16;
    const lng = ((X + 0.5) / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (Y + 0.5)) / n))) * 180) / Math.PI;
    return [lng, lat];
  };
  const request = (wayId: number): Extract<WorkerRequest, { kind: "lane-highlight" }> => ({
    id: 7,
    kind: "lane-highlight",
    streetTemplate: TEMPLATE,
    wayId,
    approach: [[centre()[0] - 0.001, centre()[1]], centre()],
    engineLanes: [{ indications: ["through"], valid: true }],
    recommended: [0],
    classes: ["urban", "motorway"],
  });

  it("reads the street tiles the approach passes and answers with a reason when the way is absent", async () => {
    const fetchMock = fakeFetch();
    const core = coreWith(fetchMock);
    const { response } = await core.handle(request(1));
    expect(response).toEqual({
      id: 7,
      kind: "lane-highlight",
      answer: { polygons: null, reason: "no-way" },
    });
    expect(fetchMock).toHaveBeenCalledWith(STREET_URL);
  });

  it("answers no-ids without street tiles", async () => {
    const core = coreWith(
      fakeFetch({ [STREET_URL]: async () => new Response(null, { status: 404 }) }),
    );
    const { response } = await core.handle(request(1));
    expect(response).toMatchObject({ answer: { polygons: null, reason: "no-ids" } });
  });
});

describe("encodePaintTile", () => {
  it("keeps a 0.10 m line within 10 % at z18", () => {
    // z18 at 52.5°N: 0.0227 m per 4096-unit; the encoder writes 8192 units per tile.
    const metresPerUnit = 0.0227 / 2;
    const line: PaintPolygon = {
      kind: "rail",
      layer: 0,
      rings: [
        [
          [10, 10],
          [20, 10],
          [20, 10.1],
          [10, 10.1],
        ],
      ],
    };
    const tile = new VectorTile(
      new PbfReader(encodePaintTile([line], [0, 0], metresPerUnit, 8192)),
    );
    const feature = tile.layers.paint?.feature(0);
    const ring = (feature?.loadGeometry()[0] ?? []).map((p): Pt => [p.x, p.y]);
    const area = Math.abs(ringArea(ring)) * metresPerUnit * metresPerUnit;
    expect(Math.abs(area / 10 - 0.1) / 0.1).toBeLessThan(0.1);
    expect(feature?.properties).toEqual({ kind: "rail", layer: 0 });
  });
});
