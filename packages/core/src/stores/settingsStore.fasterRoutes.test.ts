import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureStorage, getStorage } from "../platform/storage";
import { useSettingsStore } from "./settingsStore";

const previousStorage = getStorage();
beforeEach(() => {
  const values = new Map<string, string>();
  configureStorage({
    getString: (key) => values.get(key) ?? null,
    setString: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
  });
  useSettingsStore.setState({ fasterRoutes: true, autoSwitchFasterRoutes: false });
});
afterEach(() => configureStorage(previousStorage));

describe("fasterRoutes setting", () => {
  it.each([
    ["fasterRoutes", "setFasterRoutes", "openmapx:nav:fasterRoutes"],
    ["autoSwitchFasterRoutes", "setAutoSwitchFasterRoutes", "openmapx:nav:autoSwitchFasterRoutes"],
  ] as const)("persists and hydrates %s in both directions", (field, setter, key) => {
    for (const choice of [false, true]) {
      useSettingsStore.getState()[setter](choice);
      expect(getStorage().getString(key)).toBe(String(choice));
      useSettingsStore.setState({ [field]: !choice });
      useSettingsStore.getState().hydrate();
      expect(useSettingsStore.getState()[field]).toBe(choice);
    }
  });
});
