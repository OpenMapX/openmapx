import { create } from "zustand";
import { getStorage } from "../platform/storage";
import type { UnitSystem } from "../types/geometry";
import type { DateFormat, TimeFormat } from "../utils/dateTimeFormat";

const UNITS_STORAGE_KEY = "openmapx:unitSystem";
const TIME_FORMAT_STORAGE_KEY = "openmapx:timeFormat";
const DATE_FORMAT_STORAGE_KEY = "openmapx:dateFormat";
const VOICE_TIMING_STORAGE_KEY = "openmapx:voiceGuidanceTiming";
const SPEED_CAMERA_ALERTS_STORAGE_KEY = "openmapx:speedCameraAlerts";
const AI_SEARCH_STORAGE_KEY = "openmapx:aiSearch";
const INCIDENT_ALERTS_STORAGE_KEY = "openmapx:incidentAlerts";
const AVOID_INCIDENTS_STORAGE_KEY = "openmapx:avoidIncidents";

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

// Natural-language ("AI") search is on by default; users can opt out for privacy
// or to avoid the inference latency. Stored only when toggled, so an absent value
// means enabled.
function readAiSearch(): boolean {
  return getStorage().getString(AI_SEARCH_STORAGE_KEY) !== "false";
}

// Traffic-incident announcements during navigation are on by default (no legal
// gate, unlike speed cameras); stored only when toggled, so absent means on.
function readIncidentAlerts(): boolean {
  return getStorage().getString(INCIDENT_ALERTS_STORAGE_KEY) !== "false";
}

// Avoid closures/incidents when routing is opt-in (default off); consumed by
// Phase-2 routing exclusion.
function readAvoidIncidents(): boolean {
  // Defaults ON: steering around reported closures is the safer behavior, and
  // the toggle lives in the directions panel's Options for easy opt-out.
  const v = getStorage().getString(AVOID_INCIDENTS_STORAGE_KEY);
  return v === null ? true : v === "true";
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
  /** Natural-language ("AI") search understanding (on by default; opt-out). */
  aiSearchEnabled: boolean;
  setAiSearchEnabled: (v: boolean) => void;
  /** Announce traffic incidents ahead during navigation (on by default). */
  incidentAlerts: boolean;
  setIncidentAlerts: (v: boolean) => void;
  /** Avoid closures/incidents when routing (off by default; Phase-2 routing). */
  avoidIncidents: boolean;
  setAvoidIncidents: (v: boolean) => void;
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
  aiSearchEnabled: readAiSearch(),
  setAiSearchEnabled: (aiSearchEnabled) => {
    getStorage().setString(AI_SEARCH_STORAGE_KEY, String(aiSearchEnabled));
    set({ aiSearchEnabled });
  },
  incidentAlerts: readIncidentAlerts(),
  setIncidentAlerts: (incidentAlerts) => {
    getStorage().setString(INCIDENT_ALERTS_STORAGE_KEY, String(incidentAlerts));
    set({ incidentAlerts });
  },
  avoidIncidents: readAvoidIncidents(),
  setAvoidIncidents: (avoidIncidents) => {
    getStorage().setString(AVOID_INCIDENTS_STORAGE_KEY, String(avoidIncidents));
    set({ avoidIncidents });
  },
  hydrate: () =>
    set({
      units: readUnits(),
      timeFormat: readTimeFormat(),
      dateFormat: readDateFormat(),
      voiceGuidanceTiming: readVoiceTiming(),
      speedCameraAlerts: readSpeedCameraAlerts(),
      aiSearchEnabled: readAiSearch(),
      incidentAlerts: readIncidentAlerts(),
      avoidIncidents: readAvoidIncidents(),
    }),
}));
