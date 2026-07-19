import type { RentalProviderGroup } from "@motis-project/motis-client";
import { rentals as motisRentals } from "@motis-project/motis-client";
import type { TransitRentalFormFactor } from "@openmapx/integration-framework";
import type { MotisInstance } from "./instances.js";

/**
 * Form factors OpenMapX can offer as a transit access mode. MOTIS may report
 * others (e.g. "OTHER"); those aren't selectable, so they're filtered out.
 */
const ROUTABLE: readonly TransitRentalFormFactor[] = [
  "BICYCLE",
  "CARGO_BICYCLE",
  "SCOOTER_STANDING",
  "SCOOTER_SEATED",
  "CAR",
  "MOPED",
];
const ROUTABLE_SET = new Set<string>(ROUTABLE);

/**
 * The routable rental form factors present across a MOTIS `/rentals` provider
 * groups response, in a stable order. Pure — unit-tested independently of the
 * network.
 */
export function routableFormFactorsFromGroups(
  groups: Pick<RentalProviderGroup, "formFactors">[] | undefined,
): TransitRentalFormFactor[] {
  const present = new Set<string>();
  for (const group of groups ?? []) {
    for (const factor of group.formFactors ?? []) {
      if (ROUTABLE_SET.has(factor)) present.add(factor);
    }
  }
  return ROUTABLE.filter((factor) => present.has(factor));
}

const REFRESH_TTL_MS = 15 * 60_000;
const MIN_RETRY_MS = 30_000;
const cache = new Map<string, { factors: TransitRentalFormFactor[]; at: number }>();
const lastAttempt = new Map<string, number>();
const inflight = new Set<string>();

async function probe(instance: MotisInstance): Promise<void> {
  try {
    const { data } = await motisRentals({ client: instance.client, query: {} });
    cache.set(instance.provider, {
      factors: routableFormFactorsFromGroups(data?.providerGroups),
      at: Date.now(),
    });
  } catch {
    // Keep the last known value; a transient MOTIS blip must not blank the
    // rental options. Retry is bounded by MIN_RETRY_MS below.
  }
}

/**
 * Refresh in the background when the cached value is stale/absent, at most once
 * per MIN_RETRY_MS while a probe keeps failing (so a down MOTIS isn't hammered)
 * and once per REFRESH_TTL_MS once it succeeds.
 */
function ensureFresh(instance: MotisInstance): void {
  const key = instance.provider;
  const entry = cache.get(key);
  if (entry && Date.now() - entry.at < REFRESH_TTL_MS) return;
  if (inflight.has(key)) return;
  if (Date.now() - (lastAttempt.get(key) ?? 0) < MIN_RETRY_MS) return;
  inflight.add(key);
  lastAttempt.set(key, Date.now());
  void probe(instance).finally(() => inflight.delete(key));
}

/** Kick off an initial background probe (call once at setup). */
export function primeRentalFormFactors(instance: MotisInstance): void {
  ensureFresh(instance);
}

/**
 * Latest known routable rental form factors for the instance, derived live from
 * MOTIS `/rentals` (the source of truth for what the engine can actually route).
 * Triggers a lazy background refresh; returns [] until the first probe lands.
 */
export function getRentalFormFactors(instance: MotisInstance): TransitRentalFormFactor[] {
  ensureFresh(instance);
  return cache.get(instance.provider)?.factors ?? [];
}
