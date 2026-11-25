import { beforeEach, describe, expect, it } from "vitest";
import { configureStorage, type StorageAdapter } from "../platform/storage";
import { readLastMapView, writeLastMapView } from "./lastMapView";
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

describe("last map view", () => {
  let storage: StorageAdapter;
  beforeEach(() => {
    storage = makeMemoryStorage();
    configureStorage(storage);
    useSettingsStore.getState().hydrate();
  });

  it("remembers the view by default", () => {
    expect(useSettingsStore.getState().rememberMapView).toBe(true);
    writeLastMapView({ center: [13.405, 52.52], zoom: 14.5 });
    expect(readLastMapView()).toEqual({ center: [13.405, 52.52], zoom: 14.5 });
  });

  it("has no view before one is saved", () => {
    expect(readLastMapView()).toBeNull();
  });

  it("ignores a corrupt or out-of-range saved view", () => {
    storage.setString("openmapx:map:last-view", "{not json");
    expect(readLastMapView()).toBeNull();
    storage.setString("openmapx:map:last-view", JSON.stringify({ center: [200, 10], zoom: 3 }));
    expect(readLastMapView()).toBeNull();
    storage.setString("openmapx:map:last-view", JSON.stringify({ center: [10, 10], zoom: "3" }));
    expect(readLastMapView()).toBeNull();
    writeLastMapView({ center: [Number.NaN, 10], zoom: 3 });
    expect(readLastMapView()).toBeNull();
  });

  it("deletes the saved view and stops saving when switched off", () => {
    writeLastMapView({ center: [13.405, 52.52], zoom: 14 });
    useSettingsStore.getState().setRememberMapView(false);

    expect(storage.getString("openmapx:map:remember-view")).toBe("false");
    expect(storage.getString("openmapx:map:last-view")).toBeNull();
    writeLastMapView({ center: [6.08, 50.78], zoom: 12 });
    expect(storage.getString("openmapx:map:last-view")).toBeNull();
    expect(readLastMapView()).toBeNull();

    useSettingsStore.setState({ rememberMapView: true });
    useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().rememberMapView).toBe(false);
  });

  it("honours a stored opt-out before the settings store is hydrated", () => {
    storage.setString("openmapx:map:remember-view", "false");
    storage.setString("openmapx:map:last-view", JSON.stringify({ center: [10, 10], zoom: 3 }));
    expect(useSettingsStore.getState().rememberMapView).toBe(true);
    expect(readLastMapView()).toBeNull();
  });
});
