import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureStorage, type StorageAdapter } from "../../platform/storage";

let values: Map<string, string>;
const storage: StorageAdapter = {
  getString: (key) => values.get(key) ?? null,
  setString: (key, value) => values.set(key, value),
  remove: (key) => values.delete(key),
};

/** The store reads stored preferences when its module loads. */
async function loadStore() {
  vi.resetModules();
  const { configureStorage: configure } = await import("../../platform/storage");
  configure(storage);
  return (await import("../layerStore")).useLayerStore;
}

beforeEach(() => {
  values = new Map();
});

afterEach(() => configureStorage({ getString: () => null, setString: () => {}, remove: () => {} }));

describe("globe lighting preference", () => {
  it("is on by default", async () => {
    expect((await loadStore()).getState().globeLighting).toBe(true);
  });

  it("restores a stored choice to turn it off", async () => {
    values.set("openmapx:globeLighting", "false");
    expect((await loadStore()).getState().globeLighting).toBe(false);
  });

  it("persists both choices", async () => {
    const store = await loadStore();
    store.getState().setGlobeLighting(false);
    expect(store.getState().globeLighting).toBe(false);
    expect(values.get("openmapx:globeLighting")).toBe("false");
    store.getState().setGlobeLighting(true);
    expect(store.getState().globeLighting).toBe(true);
    expect(values.get("openmapx:globeLighting")).toBe("true");
  });
});
