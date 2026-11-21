import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as { key: string; value: unknown }[],
  local: false,
  fail: false,
  reads: 0,
  datasets: null as { basemap: boolean; streetDetail: boolean } | null,
}));
vi.mock("../../db/index.js", () => ({
  db: {
    select: () => ({
      from: async () => {
        state.reads++;
        if (state.fail) throw new Error("unavailable");
        return state.rows;
      },
    }),
  },
}));
vi.mock("../../db/schema.js", () => ({ systemSettings: {} }));
vi.mock("../../services/service-registry.js", () => ({
  serviceUrl: () => (state.local ? "http://tileserver:8080" : null),
}));
vi.mock("../../services/tileserver-datasets.js", () => ({
  tileserverDatasets: async () => (state.local ? state.datasets : null),
}));

import { invalidateMapSettings } from "../../utils/map-settings.js";
import { mapConfigRoute } from "../map-config.js";

afterEach(() => {
  state.rows = [];
  state.local = false;
  state.fail = false;
  state.reads = 0;
  state.datasets = null;
  invalidateMapSettings();
  vi.unstubAllEnvs();
});
async function request() {
  const app = Fastify();
  await app.register(mapConfigRoute);
  const res = await app.inject("/map-config");
  await app.close();
  return res;
}

describe("public map configuration", () => {
  it("returns keyless defaults without secret fields", async () => {
    vi.stubEnv("MAPTILER_KEY", "");
    const res = await request();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      hostedBasemapProvider: "auto",
      maptilerConfigured: false,
      selfHostedTilesUrl: "",
      selfHostedGlyphsUrl: "",
      streetDetailTilesUrl: "",
    });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
  it("uses admin selection and key but never exposes the credential", async () => {
    state.rows = [
      { key: "hostedBasemapProvider", value: "openfreemap" },
      { key: "maptilerApiKey", value: "private-db-key" },
    ];
    const res = await request();
    expect(res.json()).toMatchObject({
      hostedBasemapProvider: "openfreemap",
      maptilerConfigured: true,
    });
    expect(res.body).not.toContain("private-db-key");
  });
  it("environment selection wins, invalid environment falls back to valid admin selection", async () => {
    state.rows = [{ key: "hostedBasemapProvider", value: "openfreemap" }];
    vi.stubEnv("BASEMAP_PROVIDER", "maptiler");
    expect((await request()).json().hostedBasemapProvider).toBe("maptiler");
    vi.stubEnv("BASEMAP_PROVIDER", "invalid");
    expect((await request()).json().hostedBasemapProvider).toBe("openfreemap");
  });
  it("publishes only public paths for an enabled local tileserver", async () => {
    state.local = true;
    state.fail = true;
    state.datasets = { basemap: true, streetDetail: true };
    const res = await request();
    expect(res.json()).toEqual({
      hostedBasemapProvider: "auto",
      maptilerConfigured: false,
      selfHostedTilesUrl: "/tiles/data/openmapx.json",
      selfHostedGlyphsUrl: "/tiles",
      streetDetailTilesUrl: "/tiles/data/street_detail.json",
    });
    expect(res.body).not.toContain("http://tileserver");
    expect(state.reads).toBe(0);
  });
  it("keeps the self-hosted basemap without street detail built before this release", async () => {
    state.local = true;
    state.datasets = { basemap: true, streetDetail: false };
    expect((await request()).json()).toMatchObject({
      selfHostedTilesUrl: "/tiles/data/openmapx.json",
      streetDetailTilesUrl: "",
    });
  });
  it("uses the hosted basemap with local street detail in hosted-basemap mode", async () => {
    vi.stubEnv("MAPTILER_KEY", "");
    state.local = true;
    state.datasets = { basemap: false, streetDetail: true };
    state.rows = [{ key: "hostedBasemapProvider", value: "openfreemap" }];
    const res = await request();
    expect(res.json()).toEqual({
      hostedBasemapProvider: "openfreemap",
      maptilerConfigured: false,
      selfHostedTilesUrl: "",
      selfHostedGlyphsUrl: "",
      streetDetailTilesUrl: "/tiles/data/street_detail.json",
    });
    expect(state.reads).toBe(1);
  });
  it("falls back to the hosted basemap when the tileserver serves neither file", async () => {
    state.local = true;
    state.datasets = { basemap: false, streetDetail: false };
    expect((await request()).json()).toMatchObject({
      selfHostedTilesUrl: "",
      selfHostedGlyphsUrl: "",
      streetDetailTilesUrl: "",
    });
  });
  it("keeps today's answer while the tileserver probe fails", async () => {
    state.local = true;
    state.fail = true;
    state.datasets = null;
    expect((await request()).json()).toMatchObject({
      selfHostedTilesUrl: "/tiles/data/openmapx.json",
      selfHostedGlyphsUrl: "/tiles",
      streetDetailTilesUrl: "",
    });
    expect(state.reads).toBe(0);
  });
});
