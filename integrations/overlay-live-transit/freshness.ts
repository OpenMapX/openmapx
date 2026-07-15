export const MAX_TRUE_POSITION_AGE_MS = 2 * 60 * 1000;

/** True vehicle markers require a valid source timestamp no older than two minutes. */
export function isFreshVehicleObservation(updatedAt: string, now = Date.now()): boolean {
  const observedAt = new Date(updatedAt).getTime();
  const age = now - observedAt;
  return Number.isFinite(observedAt) && age >= 0 && age <= MAX_TRUE_POSITION_AGE_MS;
}
