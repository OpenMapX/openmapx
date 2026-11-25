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

  it("setUnits persists and reads back imperial", () => {
    const storage = makeMemoryStorage();
    configureStorage(storage);
    useSettingsStore.getState().setUnits("imperial");
    expect(useSettingsStore.getState().units).toBe("imperial");
    expect(storage.getString("openmapx:settings:unit-system")).toBe("imperial");
    useSettingsStore.getState().setUnits("metric");
    expect(useSettingsStore.getState().units).toBe("metric");
    expect(storage.getString("openmapx:settings:unit-system")).toBe("metric");
  });

  it("setAiSearchEnabled(false) persists and hydrates back as disabled", () => {
    const storage = makeMemoryStorage();
    configureStorage(storage);
    useSettingsStore.getState().setAiSearchEnabled(false);
    expect(useSettingsStore.getState().aiSearchEnabled).toBe(false);
    expect(storage.getString("openmapx:search:ai-search")).toBe("false");
    useSettingsStore.setState({ aiSearchEnabled: true });
    useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().aiSearchEnabled).toBe(false);
  });

  it("turning search history off persists the preference and removes saved queries", () => {
    const storage = makeMemoryStorage();
    configureStorage(storage);
    storage.setString("openmapx:search:recent-searches", '["Berlin"]');

    useSettingsStore.getState().setSearchHistoryEnabled(false);

    expect(useSettingsStore.getState().searchHistoryEnabled).toBe(false);
    expect(storage.getString("openmapx:search:history-enabled")).toBe("false");
    expect(storage.getString("openmapx:search:recent-searches")).toBeNull();
    useSettingsStore.setState({ searchHistoryEnabled: true });
    useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().searchHistoryEnabled).toBe(false);
  });

  it("incident alerts and avoid-incidents both default on", () => {
    configureStorage(makeMemoryStorage());
    useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().incidentAlerts).toBe(true);
    expect(useSettingsStore.getState().avoidIncidents).toBe(true);
  });

  it("setAvoidIncidents(false) persists and hydrates back as disabled", () => {
    const storage = makeMemoryStorage();
    configureStorage(storage);
    useSettingsStore.getState().setAvoidIncidents(false);
    expect(useSettingsStore.getState().avoidIncidents).toBe(false);
    expect(storage.getString("openmapx:routing:avoid-incidents")).toBe("false");
    useSettingsStore.setState({ avoidIncidents: true });
    useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().avoidIncidents).toBe(false);
    useSettingsStore.getState().setAvoidIncidents(true);
    expect(useSettingsStore.getState().avoidIncidents).toBe(true);
    expect(storage.getString("openmapx:routing:avoid-incidents")).toBe("true");
  });

  it("setIncidentAlerts(false) persists and hydrates back as disabled", () => {
    const storage = makeMemoryStorage();
    configureStorage(storage);
    useSettingsStore.getState().setIncidentAlerts(false);
    expect(useSettingsStore.getState().incidentAlerts).toBe(false);
    expect(storage.getString("openmapx:navigation:incident-alerts")).toBe("false");
    useSettingsStore.setState({ incidentAlerts: true });
    useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().incidentAlerts).toBe(false);
  });

  it("setTouchZoomButtons(true) persists and hydrates back as enabled", () => {
    const storage = makeMemoryStorage();
    configureStorage(storage);
    useSettingsStore.getState().setTouchZoomButtons(true);
    expect(storage.getString("openmapx:map:touch-zoom-buttons")).toBe("true");
    useSettingsStore.setState({ touchZoomButtons: false });
    useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().touchZoomButtons).toBe(true);
  });

  it("navigation3d defaults to false and persists under openmapx:navigation:3d", () => {
    const storage = makeMemoryStorage();
    configureStorage(storage);
    useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().navigation3d).toBe(false);
    useSettingsStore.getState().setNavigation3d(true);
    expect(useSettingsStore.getState().navigation3d).toBe(true);
    expect(storage.getString("openmapx:navigation:3d")).toBe("true");
  });

  it("re-reading persisted preferences restores navigation3d", () => {
    const storage = makeMemoryStorage();
    configureStorage(storage);
    storage.setString("openmapx:navigation:3d", "true");
    useSettingsStore.setState({ navigation3d: false });
    useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().navigation3d).toBe(true);
  });

  it("showLocalScript defaults on and persists false across hydrate", () => {
    const storage = makeMemoryStorage();
    configureStorage(storage);
    useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().showLocalScript).toBe(true);

    useSettingsStore.getState().setShowLocalScript(false);
    expect(useSettingsStore.getState().showLocalScript).toBe(false);
    expect(storage.getString("openmapx:map:local-script")).toBe("false");
    useSettingsStore.setState({ showLocalScript: true });
    useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().showLocalScript).toBe(false);
  });
});
