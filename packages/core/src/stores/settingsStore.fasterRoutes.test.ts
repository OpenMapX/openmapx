import { describe, expect, it } from "vitest";
import { useSettingsStore } from "./settingsStore";

describe("fasterRoutes setting", () => {
  it("defaults on", () => {
    expect(useSettingsStore.getState().fasterRoutes).toBe(true);
  });

  it("persists the choice", () => {
    useSettingsStore.getState().setFasterRoutes(false);
    expect(useSettingsStore.getState().fasterRoutes).toBe(false);
    useSettingsStore.getState().setFasterRoutes(true);
    expect(useSettingsStore.getState().fasterRoutes).toBe(true);
  });
});
