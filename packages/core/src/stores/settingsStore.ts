import { create } from "zustand";
import { getStorage } from "../platform/storage";
import type { UnitSystem } from "../types/geometry";
import type { DateFormat, TimeFormat } from "../utils/dateTimeFormat";

const UNITS_STORAGE_KEY = "openmapx:unitSystem";
const TIME_FORMAT_STORAGE_KEY = "openmapx:timeFormat";
const DATE_FORMAT_STORAGE_KEY = "openmapx:dateFormat";
const VOICE_TIMING_STORAGE_KEY = "openmapx:voiceGuidanceTiming";
const SPEED_CAMERA_ALERTS_STORAGE_KEY = "openmapx:speedCameraAlerts";

const TIME_FORMATS: readonly TimeFormat[] = ["auto", "12h", "24h"];
const DATE_FORMATS: readonly DateFormat[] = ["auto", "dmy", "mdy", "ymd"];

/**
 * How early navigation voice prompts fire. `normal` keeps the tuned defaults;
 * `early` announces sooner (more reaction time), `late` closer to the maneuver.
 */
export type VoiceGuidanceTiming = "early" | "normal" | "late";
const VOICE_TIMINGS: readonly VoiceGuidanceTiming[] = ["early", "normal", "late"];

/** Multiplier applied to voice-cue trigger distances per timing preference. */
export const VOICE_TIMING_MULTIPLIER: Record<VoiceGuidanceTiming, number> = {
  early: 1.5,
  normal: 1,
  late: 0.6,
};

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

function readVoiceTiming(): VoiceGuidanceTiming {
  const v = getStorage().getString(VOICE_TIMING_STORAGE_KEY);
  return VOICE_TIMINGS.includes(v as VoiceGuidanceTiming) ? (v as VoiceGuidanceTiming) : "normal";
}

// Speed-camera alerts are opt-in (default off): they're legally restricted in
// some countries and a privacy-sensitive feature, so the user must enable them.
function readSpeedCameraAlerts(): boolean {
  return getStorage().getString(SPEED_CAMERA_ALERTS_STORAGE_KEY) === "true";
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
  /** How early navigation voice prompts fire. */
  voiceGuidanceTiming: VoiceGuidanceTiming;
  setVoiceGuidanceTiming: (t: VoiceGuidanceTiming) => void;
  /** Opt-in speed-camera approach alerts (off by default; region-gated downstream). */
  speedCameraAlerts: boolean;
  setSpeedCameraAlerts: (v: boolean) => void;
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
  voiceGuidanceTiming: readVoiceTiming(),
  setVoiceGuidanceTiming: (voiceGuidanceTiming) => {
    getStorage().setString(VOICE_TIMING_STORAGE_KEY, voiceGuidanceTiming);
    set({ voiceGuidanceTiming });
  },
  speedCameraAlerts: readSpeedCameraAlerts(),
  setSpeedCameraAlerts: (speedCameraAlerts) => {
    getStorage().setString(SPEED_CAMERA_ALERTS_STORAGE_KEY, String(speedCameraAlerts));
    set({ speedCameraAlerts });
  },
  hydrate: () =>
    set({
      units: readUnits(),
      timeFormat: readTimeFormat(),
      dateFormat: readDateFormat(),
      voiceGuidanceTiming: readVoiceTiming(),
      speedCameraAlerts: readSpeedCameraAlerts(),
    }),
}));
