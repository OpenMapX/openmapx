import type { BBox } from "@openmapx/core";
import type {
  IntegrationContext,
  RealtimeProvider,
  TripUpdate,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { Freshness } from "@openmapx/mobility-core/freshness";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type { Departure } from "@openmapx/mobility-core/transit";

/**
 * Schedule + realtime-delta merger for `getDepartures` / `getArrivals`
 * (plan §4.4(3) / D3). The base provider supplies the scheduled timetable;
 * any registered {@link RealtimeProvider} whose coverage overlaps the
 * caller-supplied bbox and that advertises `tripUpdates: true` is asked
 * for a {@link TripUpdate} per scheduled trip id. The first non-null
 * delta wins.
 *
 * Departures that already carry realtime fields (`expectedAt`,
 * `delaySeconds`, or `canceled`) are skipped — typically because the base
 * provider is itself MOTIS, which already merges GTFS-RT into its
 * `stoptimes` response. Skipping them avoids a redundant round-trip.
 */
export interface EnrichDeparturesOptions {
  /**
   * Hint bbox used to pick which realtime providers to consult. When
   * omitted, providers with `coverage: { all: true }` are tried and any
   * bbox-scoped providers are skipped.
   */
  bbox?: BBox;
  /** The stop the departures belong to — forwarded to `getTripUpdate`. */
  stopId: string;
}

function bboxesOverlap(a: BBox, b: BBox): boolean {
  return a[2] > b[0] && b[2] > a[0] && a[3] > b[1] && b[3] > a[1];
}

function providerMatches(provider: RealtimeProvider, bbox: BBox | undefined): boolean {
  if (!provider.capabilities.tripUpdates) return false;
  if (!provider.getTripUpdate && !provider.getTripUpdates) return false;
  if ("all" in provider.coverage) return true;
  if (!bbox) return false;
  return bboxesOverlap(bbox, provider.coverage.bbox);
}

function collectRealtimeProviders(ctx: IntegrationContext): RealtimeProvider[] {
  const providers: RealtimeProvider[] = [];
  for (const integration of ctx.getIntegrationsByDomain("live-transit")) {
    for (const p of (integration.providers.get("live-transit") ?? []) as RealtimeProvider[]) {
      providers.push(p);
    }
  }
  return providers.sort((a, b) => a.priority - b.priority);
}

function isAlreadyRealtime(dep: Departure): boolean {
  if (dep.provenance?.realtimeCompleteness === "merged") return true;
  if (dep.provenance?.realtimeCompleteness === "changed") return true;
  return Boolean(dep.expectedAt) || dep.delaySeconds !== undefined || Boolean(dep.canceled);
}

function applyDelta(dep: Departure, delta: TripUpdate): boolean {
  let changed = false;
  if (delta.expectedAt && delta.expectedAt !== dep.expectedAt) {
    dep.expectedAt = delta.expectedAt;
    changed = true;
  }
  if (delta.delaySeconds !== undefined && delta.delaySeconds !== dep.delaySeconds) {
    dep.delaySeconds = delta.delaySeconds;
    changed = true;
  }
  if (delta.canceled && !dep.canceled) {
    dep.canceled = true;
    changed = true;
  }
  if (delta.platform && delta.platform !== dep.platform) {
    dep.platform = delta.platform;
    changed = true;
  }
  if (changed && dep.provenance) {
    dep.provenance = {
      ...dep.provenance,
      realtimeCompleteness: "changed",
      observedAt: new Date().toISOString(),
    };
  }
  return changed;
}

type TimedCaller = <T>(
  providerId: string,
  method: string,
  fn: () => Promise<T>,
) => Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;

export interface EnrichDeps {
  ctx: IntegrationContext;
  /**
   * The same {@link TimedCaller} the orchestrator uses for its own provider
   * calls. Wiring it in means realtime-enrichment latency, health, and OTEL
   * counters all flow through the same path (G3).
   */
  timed: TimedCaller;
}

/**
 * Enrich a `MobilityResult<Departure[]>` with realtime deltas. Returns a new
 * result whose `data` shares array references with `base.data` but with
 * mutated entries — callers that need immutability should clone first.
 *
 * The attributions/freshness on the returned result include realtime
 * provider entries iff any delta was applied. When no providers match or
 * no deltas land, the base result is returned unchanged.
 */
export async function enrichDeparturesWithRealtime(
  deps: EnrichDeps,
  base: MobilityResult<Departure[]>,
  opts: EnrichDeparturesOptions,
): Promise<MobilityResult<Departure[]>> {
  if (base.data.length === 0) return base;

  const candidates = collectRealtimeProviders(deps.ctx).filter((p) =>
    providerMatches(p, opts.bbox),
  );
  if (candidates.length === 0) return base;

  // Skip departures the base provider already enriched (typical for MOTIS,
  // which returns RT-merged stoptimes natively).
  const alreadyComplete = base.data.filter((departure) => isAlreadyRealtime(departure)).length;
  if (alreadyComplete > 0) {
    deps.ctx.metricsRecorder?.recordTransitDecision?.(
      {
        operation: "realtime",
        providerId: "baseline",
        role: "baseline",
        reason: "realtime_complete",
      },
      alreadyComplete,
    );
  }
  const targets = base.data.filter((d) => d.tripId && !isAlreadyRealtime(d));
  if (targets.length === 0) return base;

  const byTrip = new Map<string, Departure[]>();
  for (const departure of targets) {
    const group = byTrip.get(departure.tripId) ?? [];
    group.push(departure);
    byTrip.set(departure.tripId, group);
  }

  const newAttributions: Attribution[] = [];
  const newFreshness: Freshness[] = [];
  let anyApplied = false;

  const remaining = new Set(byTrip.keys());
  for (const provider of candidates) {
    if (!provider.getTripUpdates || remaining.size === 0) continue;
    const ids = [...remaining];
    const outcome = await deps.timed(
      provider.id,
      "getTripUpdates",
      () =>
        provider.getTripUpdates?.(ids, opts.stopId) as ReturnType<
          NonNullable<typeof provider.getTripUpdates>
        >,
    );
    if (!outcome.ok) continue;
    for (const id of ids) {
      const delta = outcome.value.data[id];
      if (!delta) continue;
      let applied = false;
      for (const departure of byTrip.get(id) ?? [])
        applied = applyDelta(departure, delta) || applied;
      if (!applied) continue;
      anyApplied = true;
      remaining.delete(id);
    }
    if (ids.some((id) => outcome.value.data[id])) {
      newAttributions.push(...outcome.value.attributions);
      newFreshness.push(outcome.value.freshness);
    }
  }

  const deadline = Date.now() + 1_500;
  const queue = [...remaining];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length > 0 && Date.now() < deadline) {
      const tripId = queue.shift();
      if (!tripId) return;
      for (const provider of candidates) {
        const getTripUpdate = provider.getTripUpdate;
        if (!getTripUpdate || Date.now() >= deadline) continue;
        const outcome = await deps.timed(provider.id, "getTripUpdate", () =>
          getTripUpdate.call(provider, tripId, opts.stopId),
        );
        if (!outcome.ok || !outcome.value.data) continue;
        let applied = false;
        for (const departure of byTrip.get(tripId) ?? []) {
          applied = applyDelta(departure, outcome.value.data) || applied;
        }
        if (!applied) continue;
        anyApplied = true;
        newAttributions.push(...outcome.value.attributions);
        newFreshness.push(outcome.value.freshness);
        break;
      }
    }
  });
  await Promise.all(workers);

  // Mark records we inspected but could not enrich explicitly rather than
  // making absence look like a complete realtime merge.
  for (const departure of targets) {
    if (departure.provenance && departure.provenance.realtimeCompleteness === "none") {
      departure.provenance = { ...departure.provenance, realtimeCompleteness: "unknown" };
    }
  }

  if (!anyApplied) return base;

  const dedupedAttribs = dedupAttributions(deps.ctx, base.attributions, ...newAttributions);
  const freshness: Freshness = {
    fetchedAt: base.freshness.fetchedAt,
    hasRealtimeData: true,
    isStale: base.freshness.isStale,
    ...(base.freshness.dataAsOf ? { dataAsOf: base.freshness.dataAsOf } : {}),
  };
  // Propagate the strongest staleness signal from the realtime side too.
  for (const f of newFreshness) {
    if (f.isStale) freshness.isStale = true;
  }

  return { data: base.data, attributions: dedupedAttribs, freshness };
}

function dedupAttributions(
  ctx: IntegrationContext,
  base: Attribution[],
  ...extras: Attribution[]
): Attribution[] {
  const all = [...base, ...extras];
  if (ctx.attributionIndex) return ctx.attributionIndex.dedupAndOrder(all);
  const seen = new Set<string>();
  const out: Attribution[] = [];
  for (const a of all) {
    if (seen.has(a.sourceId)) continue;
    seen.add(a.sourceId);
    out.push(a);
  }
  return out;
}

export const __testing = {
  applyDelta,
  collectRealtimeProviders,
  isAlreadyRealtime,
  providerMatches,
};
