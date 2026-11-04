/** The only data allowed to cross into OS-owned navigation UI. No session payloads. */
export interface SurfaceModel {
  version: 1;
  sessionId: string;
  revision: number;
  kind: "ground" | "transit";
  status: "active" | "waiting" | "stale" | "arrived";
  title: string;
  instruction: string;
  detail: string;
  compactText: string;
  eventAtMs: number | null;
  observedAtMs: number;
  staleAtMs: number;
  expiresAtMs: number;
  locale: "en" | "de";
}
export const SURFACE_BYTES = 3000;
export const SURFACE_FRESH_MS = 60_000;
export const SURFACE_INTERVAL_MS = 5_000;
export const surfaceCopy = {
  en: {
    navigation: "Navigation",
    transit: "Transit",
    waiting: "Acquiring location",
    stale: "Location outdated — open OpenMapX",
    gps: "Weak GPS — follow road signs",
    gpsCompact: "No GPS",
    minutes: "min",
    reroute: "Rerouting",
    arrived: "You have arrived",
    walk: "Walk to",
    board: "Board at",
    ride: "Get off at",
    transfer: "Transfer at",
    schedule: "Scheduled",
    stops: "stops remaining",
    open: "Open",
    end: "End navigation",
    confirm: "End this navigation session?",
    cancel: "Cancel",
    ended: "This trip has already ended",
    unavailable: "Navigation unavailable — reopen OpenMapX to manage this trip",
  },
  de: {
    navigation: "Navigation",
    transit: "ÖPNV",
    waiting: "Standort wird ermittelt",
    stale: "Standort veraltet — OpenMapX öffnen",
    gps: "GPS schwach — Beschilderung beachten",
    gpsCompact: "Kein GPS",
    minutes: "Min.",
    reroute: "Route wird neu berechnet",
    arrived: "Ziel erreicht",
    walk: "Zu Fuß nach",
    board: "Einsteigen an",
    ride: "Aussteigen an",
    transfer: "Umsteigen an",
    schedule: "Laut Fahrplan",
    stops: "verbleibende Halte",
    open: "Öffnen",
    end: "Navigation beenden",
    confirm: "Diese Navigation beenden?",
    cancel: "Abbrechen",
    ended: "Diese Fahrt ist bereits beendet",
    unavailable: "Navigation nicht verfügbar — OpenMapX erneut öffnen, um die Fahrt zu verwalten",
  },
} as const;
export function surfaceText(value: unknown): string {
  if (typeof value !== "string") return "";
  const clean = Array.from(value)
    .map((c) => {
      const n = c.codePointAt(0) ?? 0;
      return n < 32 ||
        (n >= 127 && n <= 159) ||
        (n >= 0x202a && n <= 0x202e) ||
        (n >= 0x2066 && n <= 0x2069)
        ? " "
        : c;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  let result = "";
  for (const character of clean) {
    if (result.length + character.length > 160) break;
    result += character;
  }
  return result;
}
