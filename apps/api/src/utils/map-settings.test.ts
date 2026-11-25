import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { systemSecret } from "../db/schema";

const state = vi.hoisted(() => ({
  rows: [] as { key: string; value: unknown }[],
  secrets: [] as Record<string, unknown>[],
  secretReads: 0,
  reads: 0,
  fail: false,
}));
vi.mock("../db", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (state.fail) throw new Error("offline");
          if (table === systemSecret) {
            state.secretReads++;
            return state.secrets;
          }
          state.reads++;
          return state.rows;
        },
      }),
    }),
  },
}));

const { processLogger } = await import("../process-logger");
const { encrypt, secretAad } = await import("../services/secrets");
const { invalidateMapSettings, loadMapSettings } = await import("./map-settings");

const KEY = Buffer.alloc(32, 4).toString("base64url");
const storedKey = (value: string, key = "maptiler.apiKey") => ({
  key,
  ...encrypt(value, secretAad.systemSecret(key)),
});

beforeEach(() => {
  vi.stubEnv("OPENMAPX_SECRETS_KEY", KEY);
  vi.stubEnv("OPENMAPX_SECRETS_KEY_FILE", undefined);
  vi.stubEnv("MAPTILER_API_KEY", undefined);
  vi.stubEnv("BASEMAP_PROVIDER", undefined);
});
afterEach(() => {
  state.rows = [];
  state.secrets = [];
  state.secretReads = 0;
  state.reads = 0;
  state.fail = false;
  invalidateMapSettings();
  vi.unstubAllEnvs();
});
describe("effective map settings", () => {
  it("uses environment credentials over admin credentials", async () => {
    state.secrets = [storedKey("db-key")];
    vi.stubEnv("MAPTILER_API_KEY", "env-key");
    expect((await loadMapSettings()).maptilerApiKey).toBe("env-key");
  });
  it("treats whitespace credentials as absent", async () => {
    state.secrets = [storedKey("db-key")];
    vi.stubEnv("MAPTILER_API_KEY", "  ");
    expect((await loadMapSettings()).maptilerApiKey).toBe("db-key");
  });
  it("keeps the map working without a stored key that cannot be decrypted, warning once", async () => {
    state.rows = [{ key: "basemap.provider", value: "openfreemap" }];
    state.secrets = [{ ...storedKey("db-key"), key: "maptiler.apiKey", keyVersion: 2 }];
    const warn = vi.spyOn(processLogger, "warn").mockImplementation(() => undefined);
    try {
      expect(await loadMapSettings()).toEqual({
        hostedBasemapProvider: "openfreemap",
        maptilerApiKey: "",
      });
      invalidateMapSettings();
      await loadMapSettings();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
  it("decrypts nothing while MAPTILER_API_KEY overrides the stored key", async () => {
    state.secrets = [{ ...storedKey("db-key"), keyVersion: 2 }];
    vi.stubEnv("MAPTILER_API_KEY", "env-key");
    expect((await loadMapSettings()).maptilerApiKey).toBe("env-key");
    expect(state.secretReads).toBe(0);
  });
  it("reuses database settings until invalidated, then observes admin updates", async () => {
    state.secrets = [storedKey("first")];
    expect((await loadMapSettings()).maptilerApiKey).toBe("first");
    state.secrets = [storedKey("second")];
    expect((await loadMapSettings()).maptilerApiKey).toBe("first");
    expect(state.reads).toBe(1);
    invalidateMapSettings();
    expect((await loadMapSettings()).maptilerApiKey).toBe("second");
  });
  it("falls back to environment configuration when the database is unavailable", async () => {
    state.fail = true;
    vi.stubEnv("BASEMAP_PROVIDER", "openfreemap");
    vi.stubEnv("MAPTILER_API_KEY", "env-key");
    expect(await loadMapSettings()).toEqual({
      hostedBasemapProvider: "openfreemap",
      maptilerApiKey: "env-key",
    });
  });
});
