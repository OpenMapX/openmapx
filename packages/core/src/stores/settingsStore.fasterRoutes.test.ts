import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "./settingsStore";

beforeEach(() => {
  useSettingsStore.setState({ fasterRoutes: true, autoSwitchFasterRoutes: false });
});

describe("fasterRoutes setting", () => {
  it("defaults on", () => {
    expect(useSettingsStore.getState().fasterRoutes).toBe(true);
  });

  it("defaults automatic switching off", () => {
    expect(useSettingsStore.getState().autoSwitchFasterRoutes).toBe(false);
  });

  it("persists the choice", () => {
    useSettingsStore.getState().setFasterRoutes(false);
    expect(useSettingsStore.getState().fasterRoutes).toBe(false);
    useSettingsStore.getState().setFasterRoutes(true);
    expect(useSettingsStore.getState().fasterRoutes).toBe(true);
  });

  it("persists the automatic-switch choice", () => {
    useSettingsStore.getState().setAutoSwitchFasterRoutes(true);
    expect(useSettingsStore.getState().autoSwitchFasterRoutes).toBe(true);
    useSettingsStore.getState().setAutoSwitchFasterRoutes(false);
    expect(useSettingsStore.getState().autoSwitchFasterRoutes).toBe(false);
  });
});
