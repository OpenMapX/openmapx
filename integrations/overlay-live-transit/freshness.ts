export const MAX_TRUE_POSITION_AGE_MS = 2 * 60 * 1000;
/**
 * Clock-skew tolerance on the future side. Timestamps are stamped by the server
 * (a vehicle's `updatedAt`, and for MOTIS-interpolated positions it is the
 * server's compute time ≈ "now"), but `now` here is the client's clock. A few
 * seconds of server/client skew must not make an otherwise-current position read
 * as "in the future" — that would drop every interpolated vehicle at once and
 * flicker the whole overlay between refreshes.
 */
export const MAX_CLOCK_SKEW_MS = 60 * 1000;

/** True vehicle markers require a valid source timestamp no older than two minutes. */
export function isFreshVehicleObservation(updatedAt: string, now = Date.now()): boolean {
  const observedAt = new Date(updatedAt).getTime();
  const age = now - observedAt;
  return (
    Number.isFinite(observedAt) && age >= -MAX_CLOCK_SKEW_MS && age <= MAX_TRUE_POSITION_AGE_MS
  );
}
