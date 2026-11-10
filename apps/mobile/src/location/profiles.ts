import type { LocationProfile } from "./LocationDriver";

/**
 * Requested location cadences per travel mode.
 *
 * These are *requests*, not promises: both operating systems batch, defer and
 * throttle updates according to their own power policy. Reliability is
 * deliberately preferred over battery in the first field build, and automatic
 * pausing is disabled for every mode — a paused navigation session is
 * indistinguishable from a broken one.
 *
 * Deferred updates are not requested anywhere: they may delay a cue, and no
 * physical-device evidence yet exists to show they are safe.
 */

export const LOCATION_PROFILE_KINDS = [
  "driving",
  "motorcycle",
  "cycling",
  "walking",
  "transit-cruise",
  "transit-near-event",
  "arrival-release",
] as const;

export type LocationProfileKind = (typeof LOCATION_PROFILE_KINDS)[number];

const PROFILES: Record<LocationProfileKind, LocationProfile> = {
  driving: Object.freeze({
    accuracy: "navigation",
    timeIntervalMs: 1_000,
    distanceIntervalMeters: 3,
    activityType: "automotive-navigation",
    pausesUpdatesAutomatically: false,
  }),
  motorcycle: Object.freeze({
    accuracy: "navigation",
    timeIntervalMs: 1_000,
    distanceIntervalMeters: 3,
    activityType: "automotive-navigation",
    pausesUpdatesAutomatically: false,
  }),
  cycling: Object.freeze({
    accuracy: "navigation",
    timeIntervalMs: 1_500,
    distanceIntervalMeters: 5,
    activityType: "fitness",
    pausesUpdatesAutomatically: false,
  }),
  walking: Object.freeze({
    accuracy: "high",
    timeIntervalMs: 2_500,
    distanceIntervalMeters: 5,
    activityType: "other-navigation",
    pausesUpdatesAutomatically: false,
  }),
  // Riding between transfers needs only enough resolution to keep the leg
  // banner honest, so the cadence drops until an event approaches.
  "transit-cruise": Object.freeze({
    accuracy: "high",
    timeIntervalMs: 10_000,
    distanceIntervalMeters: 25,
    activityType: "other-navigation",
    pausesUpdatesAutomatically: false,
  }),
  // Approaching a walking segment, transfer or the alighting stop: this is when
  // a missed cue actually costs the user a stop.
  "transit-near-event": Object.freeze({
    accuracy: "high",
    timeIntervalMs: 3_000,
    distanceIntervalMeters: 10,
    activityType: "other-navigation",
    pausesUpdatesAutomatically: false,
  }),
  // After arrival, until the stream is released. Every other profile filters by
  // distance, so a user standing still at the destination gets no update, and
  // on Android a backgrounded app's JavaScript timers do not fire either. With
  // no distance filter the stream delivers on time alone, which guarantees the
  // batch that releases it. Five seconds closes the window promptly once it is
  // due without waking the device more than a few times.
  "arrival-release": Object.freeze({
    accuracy: "high",
    timeIntervalMs: 5_000,
    distanceIntervalMeters: 0,
    activityType: "other-navigation",
    pausesUpdatesAutomatically: false,
  }),
};

export function profileFor(kind: LocationProfileKind): LocationProfile {
  const profile = PROFILES[kind];
  if (!profile) throw new Error(`unknown location profile: ${String(kind)}`);
  return profile;
}

/**
 * The profile a session starts with: its travel mode for ground guidance, the
 * cruising cadence for transit (whose batch logic tightens it near an event).
 */
export function initialProfileFor(
  session:
    | { kind: "ground"; payload: { startPackage: { mode: string } } }
    | { kind: "transit" }
    | null,
): LocationProfileKind {
  if (!session || session.kind === "transit") return session ? "transit-cruise" : "driving";
  const mode = session.payload.startPackage.mode;
  return mode === "walking" || mode === "cycling" || mode === "motorcycle" ? mode : "driving";
}
