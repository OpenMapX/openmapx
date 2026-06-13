import { create } from "zustand";
import { getStorage } from "../platform/storage";
import type { UnitSystem } from "../types/geometry";
import type { DateFormat, TimeFormat } from "../utils/dateTimeFormat";

const UNITS_STORAGE_KEY = "openmapx:unitSystem";
const TIME_FORMAT_STORAGE_KEY = "openmapx:timeFormat";
const DATE_FORMAT_STORAGE_KEY = "openmapx:dateFormat";

const TIME_FORMATS: readonly TimeFormat[] = ["auto", "12h", "24h"];
const DATE_FORMATS: readonly DateFormat[] = ["auto", "dmy", "mdy", "ymd"];

function readUnits(): UnitSystem {
  return getStorage().getString(UNITS_STORAGE_KEY) === "imperial" ? "imperial" : "metric";
}

function readTimeFormat(): TimeFormat {
  const v = getStorage().getString(TIME_FORMAT_STORAGE_KEY);
  return TIME_FORMATS.includes(v as TimeFormat) ? (v as TimeFormat) : "auto";
}

function readDateFormat(): DateFormat {
  const v = getStorage().getString(DATE_FORMAT_STORAGE_KEY);
  return DATE_FORMATS.includes(v as DateFormat) ? (v as DateFormat) : "auto";
}

interface SettingsState {
  units: UnitSystem;
  setUnits: (u: UnitSystem) => void;
  /** Wall-clock time rendering preference (`auto` follows the locale). */
  timeFormat: TimeFormat;
  setTimeFormat: (f: TimeFormat) => void;
  /** Calendar-date rendering preference (`auto` follows the locale). */
  dateFormat: DateFormat;
  setDateFormat: (f: DateFormat) => void;
  /**
   * Re-read the persisted preferences from storage. The store is created at
   * module-eval time, which can run before the platform storage adapter is
   * configured; calling this once on the client (after configuration) ensures
   * the saved choices are applied instead of the defaults.
   */
  hydrate: () => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  units: readUnits(),
  setUnits: (units) => {
    getStorage().setString(UNITS_STORAGE_KEY, units);
    set({ units });
  },
  timeFormat: readTimeFormat(),
  setTimeFormat: (timeFormat) => {
    getStorage().setString(TIME_FORMAT_STORAGE_KEY, timeFormat);
    set({ timeFormat });
  },
  dateFormat: readDateFormat(),
  setDateFormat: (dateFormat) => {
    getStorage().setString(DATE_FORMAT_STORAGE_KEY, dateFormat);
    set({ dateFormat });
  },
  hydrate: () =>
    set({ units: readUnits(), timeFormat: readTimeFormat(), dateFormat: readDateFormat() }),
}));
