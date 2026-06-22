import type { LngLat } from "../types/geometry";

/**
 * Approach alerts surfaced along the route. Sourced from OSM (speed cameras,
 * level crossings, traffic calming, …) — NOT from the routing engine — and
 * announced as the driver nears them. Speed-camera handling is region-gated and
 * opt-in upstream (warnings are illegal in some countries); this module is the
 * pure selection/timing logic only.
 */
export type RoadAlertType =
  | "traffic_incident"
  | "speed_camera"
  | "railway_crossing"
  | "stop"
  | "pedestrian_crossing"
  | "traffic_calming"
  | "tunnel";

export interface RoadAlert {
  /** Stable de-dup / single-fire key. */
  id: string;
  type: RoadAlertType;
  coord: LngLat;
  /** Arc-length of the alert along the active route, metres from the start. */
  alongMeters: number;
  /** Posted limit at a speed camera, km/h, when known. */
  speedLimitKmh?: number;
  /**
   * Per-alert approach window, overriding the static per-type {@link APPROACH}.
   * Used by traffic incidents, whose window is scaled by severity.
   */
  approach?: { leadSec: number; minM: number; maxM: number };
}

export interface ActiveAlert {
  alert: RoadAlert;
  /** Distance ahead to the alert, metres. */
  distanceMeters: number;
  /**
   * Whether a speed camera warrants an active warning: the driver can't slow to
   * its limit within the remaining distance. Always true for non-camera alerts.
   */
  warn: boolean;
}

/** Priority order — lower is more important and wins when several are in range. */
const PRIORITY: Record<RoadAlertType, number> = {
  traffic_incident: 0,
  speed_camera: 1,
  railway_crossing: 2,
  stop: 3,
  pedestrian_crossing: 4,
  traffic_calming: 5,
  tunnel: 6,
};

/** Per-type approach window: announce `leadSec` ahead, clamped to [minM, maxM]. */
const APPROACH: Record<RoadAlertType, { leadSec: number; minM: number; maxM: number }> = {
  traffic_incident: { leadSec: 12, minM: 200, maxM: 800 },
  speed_camera: { leadSec: 12, minM: 120, maxM: 500 },
  railway_crossing: { leadSec: 8, minM: 60, maxM: 250 },
  stop: { leadSec: 6, minM: 40, maxM: 150 },
  pedestrian_crossing: { leadSec: 6, minM: 40, maxM: 150 },
  traffic_calming: { leadSec: 5, minM: 30, maxM: 120 },
  tunnel: { leadSec: 8, minM: 60, maxM: 300 },
};

/**
 * Country codes (lowercase ISO 3166-1 alpha-2) where speed-camera *warnings* are
 * legally restricted; cameras are suppressed there regardless of the user's
 * opt-in. A deliberately conservative list — confirm with the operator before
 * relaxing it. Other alert types (crossings, calming, stops) are unrestricted.
 */
export const CAMERA_RESTRICTED_COUNTRIES = new Set(["de", "ch", "fr"]);

// Emergency-braking model (rubber on dry asphalt): a = μ·g.
const FRICTION = 0.68;
const GRAVITY = 9.80655;

/** Distance (m) needed to brake from `speedMps` down to `targetMps`. */
export function brakingDistanceMeters(speedMps: number, targetMps: number): number {
  if (speedMps <= targetMps) return 0;
  const decel = FRICTION * GRAVITY;
  return (speedMps * speedMps - targetMps * targetMps) / (2 * decel);
}

/**
 * Whether to actively warn about a speed camera: you cannot slow to its posted
 * limit within the distance remaining. Cameras with no known limit always warn.
 */
export function shouldWarnCamera(
  speedMps: number,
  cameraLimitKmh: number | undefined,
  distanceMeters: number,
): boolean {
  const target = cameraLimitKmh && cameraLimitKmh > 0 ? cameraLimitKmh / 3.6 : 0;
  if (target === 0) return true;
  return brakingDistanceMeters(speedMps, target) >= distanceMeters;
}

function approachMeters(alert: RoadAlert, speedMps: number): number {
  const a = alert.approach ?? APPROACH[alert.type];
  return Math.min(Math.max(speedMps * a.leadSec, a.minM), a.maxM);
}

/**
 * Choose the single most important alert to surface right now: the highest
 * priority alert that is ahead of the current position, within its
 * speed-scaled approach window, and not already announced (`spoken`). Ties break
 * to the nearest. Pure — the caller adds the returned `alert.id` to `spoken`.
 */
export function selectActiveAlert(
  alerts: RoadAlert[],
  alongMeters: number,
  speedMps: number,
  spoken: string[],
): ActiveAlert | null {
  let best: ActiveAlert | null = null;
  for (const alert of alerts) {
    if (spoken.includes(alert.id)) continue;
    const distance = alert.alongMeters - alongMeters;
    if (distance <= 0) continue; // behind us
    if (distance > approachMeters(alert, speedMps)) continue; // not yet in range
    if (best === null) {
      best = { alert, distanceMeters: distance, warn: true };
      continue;
    }
    const better =
      PRIORITY[alert.type] < PRIORITY[best.alert.type] ||
      (PRIORITY[alert.type] === PRIORITY[best.alert.type] && distance < best.distanceMeters);
    if (better) best = { alert, distanceMeters: distance, warn: true };
  }
  if (best === null) return null;
  if (best.alert.type === "speed_camera") {
    best.warn = shouldWarnCamera(speedMps, best.alert.speedLimitKmh, best.distanceMeters);
  }
  return best;
}
