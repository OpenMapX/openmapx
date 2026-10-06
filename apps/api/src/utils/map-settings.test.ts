import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as { key: string; value: unknown }[],
  reads: 0,
  fail: false,
}));
vi.mock("../db/index.js", () => ({
  db: {
    select: () => ({
      from: async () => {
        state.reads++;
        if (state.fail) throw new Error("offline");
        return state.rows;
      },
    }),
  },
}));
vi.mock("../db/schema.js", () => ({ systemSettings: {} }));

import { invalidateMapSettings, loadMapSettings } from "./map-settings";

afterEach(() => {
  state.rows = [];
  state.reads = 0;
  state.fail = false;
  invalidateMapSettings();
  vi.unstubAllEnvs();
});
describe("effective map settings", () => {
  it("uses environment credentials over admin credentials", async () => {
    state.rows = [{ key: "maptilerApiKey", value: "db-key" }];
    vi.stubEnv("MAPTILER_KEY", "env-key");
    expect((await loadMapSettings()).maptilerApiKey).toBe("env-key");
  });
  it("treats whitespace credentials as absent and supports the legacy environment key", async () => {
    state.rows = [{ key: "maptilerApiKey", value: "db-key" }];
    vi.stubEnv("MAPTILER_KEY", "  ");
    vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "");
    expect((await loadMapSettings()).maptilerApiKey).toBe("db-key");
    vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "legacy-key");
    expect((await loadMapSettings()).maptilerApiKey).toBe("legacy-key");
  });
  it("reuses database settings until invalidated, then observes admin updates", async () => {
    state.rows = [{ key: "maptilerApiKey", value: "first" }];
    expect((await loadMapSettings()).maptilerApiKey).toBe("first");
    state.rows = [{ key: "maptilerApiKey", value: "second" }];
    expect((await loadMapSettings()).maptilerApiKey).toBe("first");
    expect(state.reads).toBe(1);
    invalidateMapSettings();
    expect((await loadMapSettings()).maptilerApiKey).toBe("second");
  });
  it("falls back to environment configuration when the database is unavailable", async () => {
    state.fail = true;
    vi.stubEnv("BASEMAP_PROVIDER", "openfreemap");
    vi.stubEnv("MAPTILER_KEY", "env-key");
    expect(await loadMapSettings()).toEqual({
      hostedBasemapProvider: "openfreemap",
      maptilerApiKey: "env-key",
    });
  });
});
