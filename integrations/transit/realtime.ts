import type { BBox } from "@openmapx/core";
import type {
  IntegrationContext,
  RealtimeProvider,
  TripUpdate,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  captureResultContributors,
  contributorsForRecords,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { Freshness } from "@openmapx/mobility-core/freshness";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type { Departure } from "@openmapx/mobility-core/transit";
import { mergeFreshness } from "./result-merge.js";

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

function applyDelta(dep: Departure, delta: TripUpdate, receipts?: readonly Attribution[]): boolean {
  let changed = false;
  const fields: string[] = [];

  if (delta.expectedAt && delta.expectedAt !== dep.expectedAt) {
    dep.expectedAt = delta.expectedAt;
    fields.push("expectedAt");
    changed = true;
  }
  if (delta.delaySeconds !== undefined && delta.delaySeconds !== dep.delaySeconds) {
    dep.delaySeconds = delta.delaySeconds;
    fields.push("delaySeconds");
    changed = true;
  }
  if (delta.canceled && !dep.canceled) {
    dep.canceled = true;
    fields.push("canceled");
    changed = true;
  }
  if (delta.platform && delta.platform !== dep.platform) {
    dep.platform = delta.platform;
    fields.push("platform");
    changed = true;
  }
  if (changed && receipts !== undefined) {
    const baseline =
      dep.fieldContributors ??
      Object.fromEntries(
        Object.keys(dep)
          .filter((field) => field !== "contributors" && field !== "fieldContributors")
          .map((field) => [field, snapshotContributors(dep.contributors ?? [])]),
      );

    dep.fieldContributors = {
      ...baseline,
      ...Object.fromEntries(fields.map((field) => [field, snapshotContributors(receipts)])),
    };
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
 * result with cloned departure records, preserving cached baseline snapshots.
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
  const data = base.data.map((departure) => ({
    ...departure,
    contributors: captureResultContributors(departure, base.attributions),
  }));
  const targets = data.filter((d) => d.tripId && !isAlreadyRealtime(d));
  if (targets.length === 0) return base;

  const byTrip = new Map<string, Departure[]>();
  for (const departure of targets) {
    const group = byTrip.get(departure.tripId) ?? [];
    group.push(departure);
    byTrip.set(departure.tripId, group);
  }

  const newFreshness: Freshness[] = [];
  let anyApplied = false;
  let partial = false;

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
    if (!outcome.ok) {
      partial = true;
      continue;
    }
    partial ||= outcome.value.freshness.isPartial === true;
    for (const id of ids) {
      const delta = outcome.value.data[id];
      if (!delta) continue;
      let applied = false;
      for (const departure of byTrip.get(id) ?? []) {
        if (
          !applyDelta(
            departure,
            delta,
            captureResultContributors(delta, outcome.value.attributions),
          )
        )
          continue;
        departure.contributors = snapshotContributors(
          departure.contributors ?? [],
          captureResultContributors(delta, outcome.value.attributions),
        );
        applied = true;
      }
      if (!applied) continue;
      anyApplied = true;
      remaining.delete(id);
    }
    if (ids.some((id) => !remaining.has(id))) {
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
        if (!outcome.ok) {
          partial = true;
          continue;
        }
        partial ||= outcome.value.freshness.isPartial === true;
        if (!outcome.value.data) continue;
        let applied = false;
        for (const departure of byTrip.get(tripId) ?? []) {
          if (
            !applyDelta(
              departure,
              outcome.value.data,
              captureResultContributors(outcome.value.data, outcome.value.attributions),
            )
          )
            continue;
          departure.contributors = snapshotContributors(
            departure.contributors ?? [],
            captureResultContributors(outcome.value.data, outcome.value.attributions),
          );
          applied = true;
        }
        if (!applied) continue;
        anyApplied = true;
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

  if (!anyApplied) {
    const inspected = targets.some(
      (departure) => departure.provenance?.realtimeCompleteness === "unknown",
    );
    return partial || inspected
      ? {
          ...base,
          ...(inspected ? { data } : {}),
          freshness: { ...base.freshness, ...(partial ? { isPartial: true } : {}) },
        }
      : base;
  }

  const dedupedAttribs = contributorsForRecords(data);
  const freshness: Freshness = {
    ...mergeFreshness(
      base.freshness,
      ...newFreshness.map((value) => ({ ...value, hasRealtimeData: true })),
    ),
    hasRealtimeData: true,
    ...(partial ? { isPartial: true } : {}),
  };

  return { data, attributions: dedupedAttribs, freshness };
}

export const __testing = {
  applyDelta,
  collectRealtimeProviders,
  isAlreadyRealtime,
  providerMatches,
};
