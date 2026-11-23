import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as { key: string; value: unknown }[],
  secrets: {} as Record<string, string>,
  secretFailure: undefined as Error | undefined,
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
vi.mock("../services/settings", () => ({
  isSecretSetting: (key: string) => key === "maptilerApiKey",
  loadSecretSettings: async () => {
    if (state.secretFailure) throw state.secretFailure;
    return state.secrets;
  },
}));

import { invalidateMapSettings, loadMapSettings } from "./map-settings";

afterEach(() => {
  state.rows = [];
  state.secrets = {};
  state.secretFailure = undefined;
  state.reads = 0;
  state.fail = false;
  invalidateMapSettings();
  vi.unstubAllEnvs();
});
describe("effective map settings", () => {
  it("uses environment credentials over admin credentials", async () => {
    state.secrets = { maptilerApiKey: "db-key" };
    vi.stubEnv("MAPTILER_KEY", "env-key");
    expect((await loadMapSettings()).maptilerApiKey).toBe("env-key");
  });
  it("treats whitespace credentials as absent", async () => {
    state.secrets = { maptilerApiKey: "db-key" };
    vi.stubEnv("MAPTILER_KEY", "  ");
    expect((await loadMapSettings()).maptilerApiKey).toBe("db-key");
  });
  it("reads the stored key only from the encrypted secret settings", async () => {
    state.rows = [{ key: "maptilerApiKey", value: "plain-row" }];
    expect((await loadMapSettings()).maptilerApiKey).toBe("");
  });
  it("keeps the map working without a stored key that cannot be decrypted", async () => {
    state.rows = [{ key: "hostedBasemapProvider", value: "openfreemap" }];
    state.secretFailure = new Error("The secret setting maptilerApiKey cannot be read");
    expect(await loadMapSettings()).toEqual({
      hostedBasemapProvider: "openfreemap",
      maptilerApiKey: "",
    });
  });
  it("reuses database settings until invalidated, then observes admin updates", async () => {
    state.secrets = { maptilerApiKey: "first" };
    expect((await loadMapSettings()).maptilerApiKey).toBe("first");
    state.secrets = { maptilerApiKey: "second" };
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
