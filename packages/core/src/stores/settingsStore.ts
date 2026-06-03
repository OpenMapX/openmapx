import { create } from "zustand";
import { getStorage } from "../platform/storage";
import type { UnitSystem } from "../types/geometry";

const UNITS_STORAGE_KEY = "openmapx:unitSystem";

function readUnits(): UnitSystem {
  return getStorage().getString(UNITS_STORAGE_KEY) === "imperial" ? "imperial" : "metric";
}

interface SettingsState {
  units: UnitSystem;
  setUnits: (u: UnitSystem) => void;
  /**
   * Re-read the persisted preference from storage. The store is created at
   * module-eval time, which can run before the platform storage adapter is
   * configured; calling this once on the client (after configuration) ensures
   * the saved choice is applied instead of the default.
   */
  hydrate: () => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  units: readUnits(),
  setUnits: (units) => {
    getStorage().setString(UNITS_STORAGE_KEY, units);
    set({ units });
  },
  hydrate: () => set({ units: readUnits() }),
}));
