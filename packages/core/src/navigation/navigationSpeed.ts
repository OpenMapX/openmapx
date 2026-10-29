import type { FixInput, NavigationSpeedState } from "./types";

// Recent fixes dominate the fit, balancing motorway GPS noise against slowing
// and stopping. Old evidence is discarded altogether after a GPS outage.
const SPEED_TAU_SECONDS = 2;
const RESET_AFTER_SECONDS = 15;
const MIN_ACCURACY_METERS = 5;
// A direct velocity observation constrains a subsequent missing-speed fix, but
// expires quickly so position evidence can establish acceleration or a stop.
const REPORTED_SPEED_TAU_SECONDS = 1;

/**
 * Prefer a finite receiver speed. Otherwise fit speed to real along-route
 * positions with exponentially decaying, inverse-accuracy-squared weights.
 * Weighted means/covariances retain the trend without storing a location track.
 * Times are ages relative to the newest fix, avoiding epoch-sized arithmetic.
 */
export function navigationSpeed(
  previous: NavigationSpeedState | undefined,
  fix: FixInput,
  alongMeters: number,
): { speedMps: number; state: NavigationSpeedState | undefined } {
  const reported =
    fix.speed != null && Number.isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : null;
  if (fix.coasted) return { speedMps: reported ?? previous?.speedMps ?? 0, state: previous };
  if (!Number.isFinite(fix.timestampMs)) {
    return { speedMps: previous?.speedMps ?? 0, state: previous };
  }

  const dt = previous ? (fix.timestampMs - previous.timestampMs) / 1000 : 0;
  if (previous && dt <= 0) return { speedMps: previous.speedMps, state: previous };
  const accuracy = Number.isFinite(fix.accuracy)
    ? Math.max(fix.accuracy, MIN_ACCURACY_METERS)
    : MIN_ACCURACY_METERS;
  const weight = 1 / accuracy ** 2;
  // A confirmed stop ends the previous motion trend. The velocity constraint
  // below also anchors missing-speed fixes, so resetting here cannot turn one
  // subsequent noisy position delta straight into a speed spike.
  if (!previous || dt > RESET_AFTER_SECONDS || reported === 0) {
    const state: NavigationSpeedState = {
      timestampMs: fix.timestampMs,
      weight,
      meanAgeSeconds: 0,
      meanAlongMeters: alongMeters,
      varianceSeconds: 0,
      covarianceMetersSeconds: 0,
      reportedSpeedMps: reported ?? 0,
      reportedSpeedWeight: reported === null ? 0 : 1,
      speedMps: reported ?? 0,
    };
    return { speedMps: state.speedMps, state };
  }

  const oldWeight = previous.weight * Math.exp(-dt / SPEED_TAU_SECONDS);
  const totalWeight = oldWeight + weight;
  const alpha = weight / totalWeight;
  const oldAge = previous.meanAgeSeconds - dt;
  const deltaAlong = alongMeters - previous.meanAlongMeters;
  // Weighted Welford updates: adding the new observation at age zero to the
  // decayed previous fit. Covariance uses signed motion so backward GPS jitter
  // cancels forward jitter instead of accumulating a positive-speed bias.
  const varianceSeconds = (1 - alpha) * (previous.varianceSeconds + alpha * oldAge ** 2);
  const covarianceMetersSeconds =
    (1 - alpha) * (previous.covarianceMetersSeconds + alpha * -oldAge * deltaAlong);
  const reportedSpeedMps = reported ?? previous.reportedSpeedMps;
  const reportedSpeedWeight =
    reported === null
      ? previous.reportedSpeedWeight * Math.exp(-dt / REPORTED_SPEED_TAU_SECONDS)
      : 1;
  // Combine the position fit's slope evidence with the latest real receiver
  // speed (unit velocity precision). In particular, a reported stop must not
  // erase the fit or turn the next missing-speed/jitter fix into a speed spike.
  const slopeWeight = totalWeight * varianceSeconds + reportedSpeedWeight;
  const estimated =
    slopeWeight > 1e-9
      ? (totalWeight * covarianceMetersSeconds + reportedSpeedWeight * reportedSpeedMps) /
        slopeWeight
      : previous.speedMps;
  const speedMps = reported ?? Math.max(0, estimated);
  return {
    speedMps,
    state: {
      timestampMs: fix.timestampMs,
      weight: totalWeight,
      meanAgeSeconds: oldAge * (1 - alpha),
      meanAlongMeters: previous.meanAlongMeters + alpha * deltaAlong,
      varianceSeconds,
      covarianceMetersSeconds,
      reportedSpeedMps,
      reportedSpeedWeight,
      speedMps,
    },
  };
}
