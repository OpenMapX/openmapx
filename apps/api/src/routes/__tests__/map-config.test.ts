import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as { key: string; value: unknown }[],
  local: false,
  fail: false,
  reads: 0,
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

import { invalidateMapSettings } from "../../utils/map-settings.js";
import { mapConfigRoute } from "../map-config.js";

afterEach(() => {
  state.rows = [];
  state.local = false;
  state.fail = false;
  state.reads = 0;
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
    vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "");
    const res = await request();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      hostedBasemapProvider: "auto",
      maptilerConfigured: false,
      selfHostedTilesUrl: "",
      selfHostedGlyphsUrl: "",
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
    const res = await request();
    expect(res.json()).toMatchObject({
      selfHostedTilesUrl: "/tiles/data/openmapx.json",
      selfHostedGlyphsUrl: "/tiles",
    });
    expect(res.body).not.toContain("http://tileserver");
    expect(state.reads).toBe(0);
  });
});
