import { describe, expect, it, vi } from "vitest";
import { LandmarkCatalogue } from "../web/loader";
import type { CellResponse, CoverageResponse, WireAsset } from "../wire";

const API = "https://app.example";
const COVERAGE_URL = `${API}/api/integrations/landmark-models/coverage`;

function coverage(revision: string, occupied = ["2074/1409"]): CoverageResponse {
  return {
    revision,
    complete: true,
    cellZoom: 12,
    occupied,
    providers: [],
    licence: {
      name: "ODbL-1.0",
      url: "https://opendatacommons.org/licenses/odbl/1-0/",
      notice: "n",
    },
  };
}

function asset(id: string, lngLat: [number, number], minZoom = 15): WireAsset {
  const [lng, lat] = lngLat;
  return {
    id,
    name: id,
    anchor: lngLat,
    bounds: [lng - 0.0005, lat - 0.0005, lng + 0.0005, lat + 0.0005],
    elevationM: 0,
    minZoom,
    models: { low: `/api/integrations/landmark-models/models/p/${"a".repeat(64)}.glb` },
    replaces: [],
    grounding: "anchor",
    derivedFootprintAllowed: false,
    receipts: [0],
  };
}

function cell(revision: string, assets: WireAsset[]): CellResponse {
  return { revision, receipts: [{ sourceId: "src", name: "Source" }], assets };
}

function fakeFetch(routes: Map<string, () => unknown>) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const handler = routes.get(url.split("?")[0] as string);
    if (!handler) return new Response("", { status: 404 });
    return new Response(JSON.stringify(handler()), { status: 200 });
  });
}

const PARIS: [number, number, number, number] = [2.28, 48.85, 2.31, 48.87];

describe("LandmarkCatalogue", () => {
  it("requests only occupied cells and passes r", async () => {
    const routes = new Map<string, () => unknown>([
      [COVERAGE_URL, () => coverage("rev1")],
      [`${API}/api/integrations/landmark-models/cells/2074/1409`, () => cell("rev1", [])],
    ]);
    const fetchImpl = fakeFetch(routes);
    const catalogue = new LandmarkCatalogue({ apiUrl: API, fetch: fetchImpl as never });
    await catalogue.ensureCoverage();
    await catalogue.candidates(PARIS, 16, new AbortController().signal);
    const urls = fetchImpl.mock.calls.map(([url]) => url);
    expect(urls).toEqual([
      COVERAGE_URL,
      `${API}/api/integrations/landmark-models/cells/2074/1409?r=rev1`,
    ]);
  });

  it("filters candidates by minZoom and orders by distance", async () => {
    const near = asset("near", [2.295, 48.86]);
    const far = asset("far", [2.305, 48.866]);
    const tall = asset("tall", [2.296, 48.861], 17);
    const routes = new Map<string, () => unknown>([
      [COVERAGE_URL, () => coverage("rev1")],
      [
        `${API}/api/integrations/landmark-models/cells/2074/1409`,
        () => cell("rev1", [far, tall, near]),
      ],
    ]);
    const catalogue = new LandmarkCatalogue({ apiUrl: API, fetch: fakeFetch(routes) as never });
    await catalogue.ensureCoverage();
    const found = await catalogue.candidates(PARIS, 16, new AbortController().signal);
    expect(found.map((c) => c.asset.id)).toEqual(["near", "far"]);
    expect(found[0]?.receipts).toEqual([{ sourceId: "src", name: "Source" }]);
  });

  it("refetches coverage when a cell revision differs", async () => {
    let revision = "rev1";
    const routes = new Map<string, () => unknown>([
      [COVERAGE_URL, () => coverage(revision)],
      [`${API}/api/integrations/landmark-models/cells/2074/1409`, () => cell("rev2", [])],
    ]);
    const fetchImpl = fakeFetch(routes);
    const catalogue = new LandmarkCatalogue({ apiUrl: API, fetch: fetchImpl as never });
    await catalogue.ensureCoverage();
    revision = "rev2";
    await catalogue.candidates(PARIS, 16, new AbortController().signal);
    const coverageCalls = fetchImpl.mock.calls.filter(([url]) => url === COVERAGE_URL);
    expect(coverageCalls).toHaveLength(2);
    expect(coverageCalls[1]?.[1]).toMatchObject({ cache: "reload" });
    expect((await catalogue.ensureCoverage()).revision).toBe("rev2");
  });

  it("refetches coverage older than five minutes on ensureCoverage", async () => {
    let now = 0;
    const routes = new Map<string, () => unknown>([[COVERAGE_URL, () => coverage("rev1")]]);
    const fetchImpl = fakeFetch(routes);
    const catalogue = new LandmarkCatalogue({
      apiUrl: API,
      fetch: fetchImpl as never,
      now: () => now,
    });
    await catalogue.ensureCoverage();
    now = 299_000;
    await catalogue.ensureCoverage();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 301_000;
    await catalogue.ensureCoverage();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("drops cached cells when the coverage revision changes", async () => {
    let revision = "rev1";
    const routes = new Map<string, () => unknown>([
      [COVERAGE_URL, () => coverage(revision)],
      [`${API}/api/integrations/landmark-models/cells/2074/1409`, () => cell(revision, [])],
    ]);
    let now = 0;
    const fetchImpl = fakeFetch(routes);
    const catalogue = new LandmarkCatalogue({
      apiUrl: API,
      fetch: fetchImpl as never,
      now: () => now,
    });
    await catalogue.ensureCoverage();
    await catalogue.candidates(PARIS, 16, new AbortController().signal);
    await catalogue.candidates(PARIS, 16, new AbortController().signal);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    revision = "rev2";
    now = 400_000;
    await catalogue.ensureCoverage();
    await catalogue.candidates(PARIS, 16, new AbortController().signal);
    expect(fetchImpl.mock.calls.at(-1)?.[0]).toBe(
      `${API}/api/integrations/landmark-models/cells/2074/1409?r=rev2`,
    );
  });
});
