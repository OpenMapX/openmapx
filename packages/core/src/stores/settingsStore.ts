import { create } from "zustand";
import { getStorage } from "../platform/storage";
import type { ConnectorStandard, EvVehicleSpec } from "../types/ev";
import type { UnitSystem } from "../types/geometry";
import type { DateFormat, TimeFormat } from "../utils/dateTimeFormat";
import { useDirectionsStore } from "./directionsStore";

const UNITS_STORAGE_KEY = "openmapx:unitSystem";
const TIME_FORMAT_STORAGE_KEY = "openmapx:timeFormat";
const DATE_FORMAT_STORAGE_KEY = "openmapx:dateFormat";
const VOICE_TIMING_STORAGE_KEY = "openmapx:voiceGuidanceTiming";
const SPEED_CAMERA_ALERTS_STORAGE_KEY = "openmapx:speedCameraAlerts";
const AI_SEARCH_STORAGE_KEY = "openmapx:aiSearch";
const INCIDENT_ALERTS_STORAGE_KEY = "openmapx:incidentAlerts";
const AVOID_INCIDENTS_STORAGE_KEY = "openmapx:avoidIncidents";
const FASTER_ROUTES_STORAGE_KEY = "openmapx:nav:fasterRoutes";
const VOICE_NAME_STORAGE_KEY = "openmapx:voiceName";
const MAP_NORTH_UP_STORAGE_KEY = "openmapx:mapNorthUp";
const EV_VEHICLE_ID_STORAGE_KEY = "openmapx:evVehicleId";
const EV_SOC_TARGET_PCT_STORAGE_KEY = "openmapx:evSocTargetPct";
const EV_PREFERRED_NETWORKS_STORAGE_KEY = "openmapx:evPreferredNetworks";
const EV_AVOIDED_NETWORKS_STORAGE_KEY = "openmapx:evAvoidedNetworks";
const EV_EXCLUSIVE_NETWORKS_STORAGE_KEY = "openmapx:evExclusiveNetworks";
const EV_PREFER_CHEAPER_STORAGE_KEY = "openmapx:evPreferCheaper";
const EV_HOME_PRICE_PER_KWH_STORAGE_KEY = "openmapx:evHomePricePerKwh";
const EV_HOME_CURRENCY_STORAGE_KEY = "openmapx:evHomeCurrency";
const EV_CUSTOM_VEHICLE_STORAGE_KEY = "openmapx:evCustomVehicle";

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

// Defaults ON: the driver can still decline an offer, but a stopped driver
// should not have to opt in before a quicker way around traffic is found.
function readFasterRoutes(): boolean {
  const v = getStorage().getString(FASTER_ROUTES_STORAGE_KEY);
  return v === null ? true : v === "true";
}

/** Chosen TTS voice by SpeechSynthesisVoice.name; null follows the locale default. */
function readVoiceName(): string | null {
  return getStorage().getString(VOICE_NAME_STORAGE_KEY) || null;
}

function readMapNorthUp(): boolean {
  return getStorage().getString(MAP_NORTH_UP_STORAGE_KEY) === "true";
}

/** Last-chosen EV vehicle preset key (`@openmapx/ev-charge-planner`'s `VEHICLE_PRESETS`); null = none picked. */
function readEvVehicleId(): string | null {
  return getStorage().getString(EV_VEHICLE_ID_STORAGE_KEY) || null;
}

function readEvSocTargetPct(): number {
  const v = Number(getStorage().getString(EV_SOC_TARGET_PCT_STORAGE_KEY));
  return Number.isFinite(v) && v > 0 && v <= 100 ? v : 80;
}

function readStringArray(key: string): string[] {
  const raw = getStorage().getString(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function readEvPreferCheaper(): boolean {
  // Default ON: bias stop selection toward cheaper charging unless opted out.
  const v = getStorage().getString(EV_PREFER_CHEAPER_STORAGE_KEY);
  return v === null ? true : v === "true";
}

function readEvHomePricePerKwh(): number | null {
  // Distinguish "never set" from a genuine 0 — `Number(null)`/`Number("")`
  // are both 0, which would masquerade as a real tariff and feed a bogus
  // zero cost into the estimate + backend request. Same presence idiom as
  // readEvVehicleId/readVoiceName.
  const raw = getStorage().getString(EV_HOME_PRICE_PER_KWH_STORAGE_KEY);
  if (raw == null || raw === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function readEvHomeCurrency(): string {
  return getStorage().getString(EV_HOME_CURRENCY_STORAGE_KEY) || "EUR";
}

function readEvCustomVehicle(): EvVehicleSpec | null {
  // Same presence idiom as readEvHomePricePerKwh: an absent or empty entry is
  // "never set", not an all-zero spec.
  const raw = getStorage().getString(EV_CUSTOM_VEHICLE_STORAGE_KEY);
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EvVehicleSpec>;
    const positive = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && v > 0;
    if (
      !positive(parsed.batteryKwh) ||
      !positive(parsed.baseWhPerKm) ||
      !positive(parsed.maxDcKw)
    ) {
      return null;
    }
    const maxAcKw =
      typeof parsed.maxAcKw === "number" && Number.isFinite(parsed.maxAcKw) && parsed.maxAcKw >= 0
        ? parsed.maxAcKw
        : 0;
    const connectors = Array.isArray(parsed.connectors)
      ? parsed.connectors.filter((c): c is ConnectorStandard => typeof c === "string")
      : [];
    if (connectors.length === 0) return null;
    return {
      batteryKwh: parsed.batteryKwh,
      baseWhPerKm: parsed.baseWhPerKm,
      massTonnes: positive(parsed.massTonnes) ? parsed.massTonnes : 2,
      maxDcKw: parsed.maxDcKw,
      maxAcKw,
      vehicleTaperSocPct: positive(parsed.vehicleTaperSocPct) ? parsed.vehicleTaperSocPct : 80,
      connectors,
    };
  } catch {
    return null;
  }
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
  /** Offer a quicker route when live traffic changes during driving. */
  fasterRoutes: boolean;
  setFasterRoutes: (v: boolean) => void;
  /** Chosen navigation-voice name (SpeechSynthesisVoice.name); null = locale default. */
  voiceName: string | null;
  setVoiceName: (v: string | null) => void;
  /** Keep the map north-up during navigation instead of the default course-up. */
  mapNorthUp: boolean;
  setMapNorthUp: (v: boolean) => void;
  /** Last-chosen EV vehicle preset key; null = no vehicle picked yet. */
  evVehicleId: string | null;
  setEvVehicleId: (v: string | null) => void;
  /** User's charge-to preference at each EV stop, 0–100 (default 80). */
  evSocTargetPct: number;
  setEvSocTargetPct: (v: number) => void;
  /** Charging network display names to favour when planning an EV route. */
  evPreferredNetworks: string[];
  setEvPreferredNetworks: (v: string[]) => void;
  /** Charging network display names to de-prioritise when planning an EV route. */
  evAvoidedNetworks: string[];
  setEvAvoidedNetworks: (v: string[]) => void;
  /** Treat `evPreferredNetworks` as a hard whitelist instead of a soft preference. */
  evExclusiveNetworks: boolean;
  setEvExclusiveNetworks: (v: boolean) => void;
  /** Bias EV stop selection toward cheaper session cost (default on). */
  evPreferCheaper: boolean;
  setEvPreferCheaper: (v: boolean) => void;
  /** User's home electricity tariff, for the whole-trip cost estimate. Null = not set. */
  evHomePricePerKwh: number | null;
  setEvHomePricePerKwh: (v: number | null) => void;
  /** Currency of `evHomePricePerKwh`, e.g. "EUR". */
  evHomeCurrency: string;
  setEvHomeCurrency: (v: string) => void;
  /** Hand-entered spec for a car outside the bundled dataset; null = none saved. */
  evCustomVehicle: EvVehicleSpec | null;
  setEvCustomVehicle: (v: EvVehicleSpec | null) => void;
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
  fasterRoutes: readFasterRoutes(),
  setFasterRoutes: (fasterRoutes) => {
    getStorage().setString(FASTER_ROUTES_STORAGE_KEY, String(fasterRoutes));
    set({ fasterRoutes });
  },
  voiceName: readVoiceName(),
  setVoiceName: (voiceName) => {
    getStorage().setString(VOICE_NAME_STORAGE_KEY, voiceName ?? "");
    set({ voiceName });
  },
  mapNorthUp: readMapNorthUp(),
  setMapNorthUp: (mapNorthUp) => {
    getStorage().setString(MAP_NORTH_UP_STORAGE_KEY, String(mapNorthUp));
    set({ mapNorthUp });
  },
  evVehicleId: readEvVehicleId(),
  setEvVehicleId: (evVehicleId) => {
    getStorage().setString(EV_VEHICLE_ID_STORAGE_KEY, evVehicleId ?? "");
    set({ evVehicleId });
  },
  evSocTargetPct: readEvSocTargetPct(),
  setEvSocTargetPct: (evSocTargetPct) => {
    getStorage().setString(EV_SOC_TARGET_PCT_STORAGE_KEY, String(evSocTargetPct));
    set({ evSocTargetPct });
  },
  evPreferredNetworks: readStringArray(EV_PREFERRED_NETWORKS_STORAGE_KEY),
  setEvPreferredNetworks: (evPreferredNetworks) => {
    getStorage().setString(EV_PREFERRED_NETWORKS_STORAGE_KEY, JSON.stringify(evPreferredNetworks));
    set({ evPreferredNetworks });
    // Editing the network list directly re-asserts the user's intent, so drop
    // any lingering one-shot "route without the network restriction" override
    // (otherwise it would silently keep the whitelist disabled).
    useDirectionsStore.getState().setEvForceNonExclusive(false);
  },
  evAvoidedNetworks: readStringArray(EV_AVOIDED_NETWORKS_STORAGE_KEY),
  setEvAvoidedNetworks: (evAvoidedNetworks) => {
    getStorage().setString(EV_AVOIDED_NETWORKS_STORAGE_KEY, JSON.stringify(evAvoidedNetworks));
    set({ evAvoidedNetworks });
  },
  evExclusiveNetworks: getStorage().getString(EV_EXCLUSIVE_NETWORKS_STORAGE_KEY) === "true",
  setEvExclusiveNetworks: (evExclusiveNetworks) => {
    getStorage().setString(EV_EXCLUSIVE_NETWORKS_STORAGE_KEY, String(evExclusiveNetworks));
    set({ evExclusiveNetworks });
    // Toggling the whitelist directly re-asserts the user's intent, so drop
    // any lingering one-shot "route without the network restriction" override.
    useDirectionsStore.getState().setEvForceNonExclusive(false);
  },
  evPreferCheaper: readEvPreferCheaper(),
  setEvPreferCheaper: (evPreferCheaper) => {
    getStorage().setString(EV_PREFER_CHEAPER_STORAGE_KEY, String(evPreferCheaper));
    set({ evPreferCheaper });
  },
  evHomePricePerKwh: readEvHomePricePerKwh(),
  setEvHomePricePerKwh: (evHomePricePerKwh) => {
    getStorage().setString(EV_HOME_PRICE_PER_KWH_STORAGE_KEY, String(evHomePricePerKwh ?? ""));
    set({ evHomePricePerKwh });
  },
  evHomeCurrency: readEvHomeCurrency(),
  setEvHomeCurrency: (evHomeCurrency) => {
    getStorage().setString(EV_HOME_CURRENCY_STORAGE_KEY, evHomeCurrency);
    set({ evHomeCurrency });
  },
  evCustomVehicle: readEvCustomVehicle(),
  setEvCustomVehicle: (evCustomVehicle) => {
    getStorage().setString(
      EV_CUSTOM_VEHICLE_STORAGE_KEY,
      evCustomVehicle ? JSON.stringify(evCustomVehicle) : "",
    );
    set({ evCustomVehicle });
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
      fasterRoutes: readFasterRoutes(),
      voiceName: readVoiceName(),
      mapNorthUp: readMapNorthUp(),
      evVehicleId: readEvVehicleId(),
      evSocTargetPct: readEvSocTargetPct(),
      evPreferredNetworks: readStringArray(EV_PREFERRED_NETWORKS_STORAGE_KEY),
      evAvoidedNetworks: readStringArray(EV_AVOIDED_NETWORKS_STORAGE_KEY),
      evExclusiveNetworks: getStorage().getString(EV_EXCLUSIVE_NETWORKS_STORAGE_KEY) === "true",
      evPreferCheaper: readEvPreferCheaper(),
      evHomePricePerKwh: readEvHomePricePerKwh(),
      evHomeCurrency: readEvHomeCurrency(),
      evCustomVehicle: readEvCustomVehicle(),
    }),
}));
