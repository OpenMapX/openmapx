import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as { key: string; value: unknown }[],
  secrets: {} as Record<string, string>,
  local: false,
  fail: false,
  reads: 0,
  datasets: null as { basemap: boolean; streetDetail: boolean } | null,
}));
vi.mock("../../services/settings.js", () => {
  const defaults: Record<string, string> = { "basemap.provider": "auto", "maptiler.apiKey": "" };
  const envNames: Record<string, string> = {
    "basemap.provider": "BASEMAP_PROVIDER",
    "maptiler.apiKey": "MAPTILER_API_KEY",
  };
  return {
    SecretSettingUnreadableError: class extends Error {},
    // Environment, then the stored value, then the default, as the resolver orders them.
    resolveSetting: async (key: string, options: { database?: null } = {}) => {
      const env = process.env[envNames[key] ?? ""]?.trim();
      if (env) {
        if (key === "basemap.provider" && !["auto", "openfreemap", "maptiler"].includes(env))
          throw new Error("BASEMAP_PROVIDER is invalid");
        return env;
      }
      if (options.database === null) return defaults[key];
      state.reads++;
      if (state.fail) throw new Error("unavailable");
      return (
        state.secrets[key] ?? state.rows.find((row) => row.key === key)?.value ?? defaults[key]
      );
    },
  };
});
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
  state.secrets = {};
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
    vi.stubEnv("MAPTILER_API_KEY", "");
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
    state.rows = [{ key: "basemap.provider", value: "openfreemap" }];
    state.secrets = { "maptiler.apiKey": "private-db-key" };
    const res = await request();
    expect(res.json()).toMatchObject({
      hostedBasemapProvider: "openfreemap",
      maptilerConfigured: true,
    });
    expect(res.body).not.toContain("private-db-key");
  });
  it("lets the environment selection win over the admin selection", async () => {
    state.rows = [{ key: "basemap.provider", value: "openfreemap" }];
    vi.stubEnv("BASEMAP_PROVIDER", "maptiler");
    expect((await request()).json().hostedBasemapProvider).toBe("maptiler");
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
    vi.stubEnv("MAPTILER_API_KEY", "");
    state.local = true;
    state.datasets = { basemap: false, streetDetail: true };
    state.rows = [{ key: "basemap.provider", value: "openfreemap" }];
    const res = await request();
    expect(res.json()).toEqual({
      hostedBasemapProvider: "openfreemap",
      maptilerConfigured: false,
      selfHostedTilesUrl: "",
      selfHostedGlyphsUrl: "",
      streetDetailTilesUrl: "/tiles/data/street_detail.json",
    });
    expect(state.reads).toBe(2);
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
