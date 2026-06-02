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
}

export const useSettingsStore = create<SettingsState>((set) => ({
  units: readUnits(),
  setUnits: (units) => {
    getStorage().setString(UNITS_STORAGE_KEY, units);
    set({ units });
  },
}));
