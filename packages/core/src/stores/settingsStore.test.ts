import { beforeEach, describe, expect, it } from "vitest";
import { configureStorage, type StorageAdapter } from "../platform/storage";
import { useSettingsStore } from "./settingsStore";

function makeMemoryStorage(): StorageAdapter {
  const map = new Map<string, string>();
  return {
    getString: (key) => map.get(key) ?? null,
    setString: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

describe("useSettingsStore", () => {
  beforeEach(() => {
    configureStorage(makeMemoryStorage());
    useSettingsStore.setState({ units: "metric" });
  });

  it("defaults to metric", () => {
    expect(useSettingsStore.getState().units).toBe("metric");
  });

  it("setUnits persists and reads back imperial", () => {
    const storage = makeMemoryStorage();
    configureStorage(storage);
    useSettingsStore.getState().setUnits("imperial");
    expect(useSettingsStore.getState().units).toBe("imperial");
    expect(storage.getString("openmapx:unitSystem")).toBe("imperial");
  });

  it("setUnits switches back to metric", () => {
    useSettingsStore.getState().setUnits("imperial");
    useSettingsStore.getState().setUnits("metric");
    expect(useSettingsStore.getState().units).toBe("metric");
  });

  it("AI search defaults to enabled", () => {
    const storage = makeMemoryStorage();
    configureStorage(storage);
    useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().aiSearchEnabled).toBe(true);
  });

  it("setAiSearchEnabled(false) persists and hydrates back as disabled", () => {
    const storage = makeMemoryStorage();
    configureStorage(storage);
    useSettingsStore.getState().setAiSearchEnabled(false);
    expect(useSettingsStore.getState().aiSearchEnabled).toBe(false);
    expect(storage.getString("openmapx:aiSearch")).toBe("false");
    useSettingsStore.setState({ aiSearchEnabled: true });
    useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().aiSearchEnabled).toBe(false);
  });
});
