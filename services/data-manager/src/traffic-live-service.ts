import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readBoundedResponseText } from "@openmapx/core";
import type { PlannedTrafficClosures } from "@openmapx/core/data-manager-contracts";
import { envInt, envString } from "@openmapx/core/server-env";
import { runLocalDataExecution } from "./jobs/execution/local.js";
import {
  type BoundCondition,
  type ConditionsToEdgesResult,
  conditionRoutingDecision,
  conditionsToEdges,
  emptyConditionsToEdges,
  parseConditionsJson,
  spanKey,
} from "./jobs/traffic/conditions-to-edges.js";
import {
  recordTrafficConditionsFailure,
  recordTrafficConditionsSuccess,
  recordTrafficFlowFailure,
  recordTrafficFlowSuccess,
  recordTrafficGraphFailure,
  recordTrafficGraphSuccess,
  trafficEvidencePath as resolveTrafficEvidencePath,
} from "./jobs/traffic/evidence.js";
import { readTrafficGraphState } from "./jobs/traffic/graph-generation.js";
import { createLiveTrafficWriter } from "./jobs/traffic/live-writer-client.js";
import { plannedClosures } from "./jobs/traffic/planned-closures.js";
import { fetchTrafficPolicy, type TrafficPolicy } from "./jobs/traffic/policy.js";
import { buildTrafficReceipts, type TrafficApplicationSnapshot } from "./jobs/traffic/receipts.js";
import {
  loadSpanEdgeCache,
  type ResolveSpanEdgesResult,
  resolveSpanEdges,
  type SpanEdgeCache,
  type SpanEdgesDeps,
  saveSpanEdgeCache,
  traceSpanEdges as traceSpanEdgesDefault,
} from "./jobs/traffic/span-edges.js";
import {
  loadWaysToEdges as loadWaysToEdgesDefault,
  type WayEdge,
} from "./jobs/traffic/ways-to-edges.js";
import {
  TRAFFIC_LEASE_MAX_MS,
  type WriteLiveTrafficDeps,
  type WriteLiveTrafficResult,
} from "./jobs/traffic/write-live.js";
import { fetchWithTimeout } from "./jobs/transitous/motis-probe.js";

/**
 * How long before a live write's lease ends the next cycle must run. A cycle
 * whose lease would end before the next tick plus this margin runs early
 * instead, and a road-event effect, policy or conditions set that ends sooner
 * than this is left out of the write: no renewal could replace it in time,
 * and a lapsed lease makes Valhalla's watchdog stop the engine.
 */
export const TRAFFIC_LEASE_RENEWAL_MS = 45_000;
/** Bounds a single OpenConditions speed-feed fetch; mirrors `fetchJson`'s default. */
const TRAFFIC_LIVE_FETCH_TIMEOUT_MS = 10_000;
const MISSING_WAYS_REFRESH_MIN_INTERVAL_MS = 3_600_000;

interface TrafficLiveLog {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Live-traffic settings and test seams; `CronSetupOptions` carries them. */
export interface TrafficLiveOptions {
  /**
   * data-manager's own view of the same `traffic.tar` file the Valhalla
   * container mmaps. They don't share a container filesystem — Valhalla mounts
   * host `data/valhalla/osm-pbf` at `/custom_files` (its `osm-pbf` consume
   * mount), and data-manager reaches that SAME host dir through its own `/data`
   * mount. Defaults to `TRAFFIC_TAR_PATH`, then `<dataDir>/valhalla/osm-pbf/
   * traffic.tar` — the host path Valhalla's `/custom_files/traffic.tar`
   * resolves to. NOT data-manager's `/data/osm` produce dir (a separate
   * hardlink target Valhalla only sees after an explicit `POST /link`).
   */
  trafficTarPath?: string;
  /** Where `writeLiveTraffic` persists its staleness state. Test seam; production uses the function's own default. */
  trafficLiveStatePath?: string;
  /** Versioned traffic freshness evidence path. Defaults beside the live-state file. */
  trafficEvidencePath?: string;
  /**
   * Test seam: invoked instead of a real `fetch()` against
   * `${openConditionsUrl}/segments/speed.csv`.
   */
  fetchLiveTrafficCsv?: () => Promise<string>;
  /**
   * Test seam: invoked instead of a real `fetch()` against
   * `${openConditionsUrl}/segments/conditions.json`.
   */
  fetchConditionsJson?: () => Promise<string>;
  fetchTrafficPolicy?: () => Promise<TrafficPolicy>;
  /**
   * How long the last successfully-fetched condition set stays usable after a
   * failed fetch. Defaults to `TRAFFIC_CONDITIONS_STALE_MS`.
   */
  trafficConditionsStaleMs?: number;
  /**
   * Base URL of the Valhalla container span tracing snaps against. Defaults to
   * `TRAFFIC_VALHALLA_URL`, deliberately its own variable: the app-side Valhalla
   * endpoint may point at a hosted routing service, which knows nothing about
   * this deployment's graph ids and would fail every trace.
   */
  valhallaUrl?: string;
  /**
   * Test seam: invoked instead of the real `traceSpanEdges` (which posts to
   * Valhalla's `/trace_attributes`).
   */
  traceSpanEdges?: typeof traceSpanEdgesDefault;
  /** Where the traced span→edge results persist. Defaults to `<dataDir>/traffic/span-edges-cache.json`. */
  spanEdgeCachePath?: string;
  /**
   * Test seam: invoked instead of the real `loadWaysToEdges` (which reads
   * the JSON map `refreshWaysToEdges` last wrote to disk).
   */
  loadWaysToEdges?: () => Promise<Map<number, WayEdge[]>>;
  /**
   * Whether road-event overrides are written (`active`) or only computed
   * (`shadow`). Defaults to `TRAFFIC_ROAD_CONDITIONS_MODE`, then `shadow`.
   */
  roadConditionsMode?: "shadow" | "active";
  readTrafficGraphState?: () => Promise<{ generation: string; engineBootId: string }>;
  /** Fatal worker lifecycle notification; production exits for supervisor recovery. */
  onTrafficWriterFailure?: (error: Error) => void;
  /**
   * Test seam: invoked instead of the real `writeLiveTraffic` (which opens
   * `trafficTarPath` for in-place writes).
   */
  writeLiveTraffic?: (deps: WriteLiveTrafficDeps) => Promise<WriteLiveTrafficResult>;
}

export interface TrafficLiveServiceDeps {
  options: TrafficLiveOptions;
  dataDir: string;
  log: TrafficLiveLog;
  /** Empty when OpenConditions is not configured; a cycle then does nothing. */
  openConditionsUrl: string;
  openConditionsRequest: { headers: Record<string, string> };
  /** When the schedule fires next, if it is scheduled at all. */
  nextScheduledRun: () => number | undefined;
  /** Ask for a graph maintenance check after the engine's graph could not be attested. */
  scheduleGraphMaintenanceCheck: () => void;
  /** Refresh the way→edge map; never rejects. */
  refreshWaysToEdges: () => Promise<void>;
}

/**
 * The live-speed writer and its read model: each cycle fetches the
 * OpenConditions speed feed, conditions and policy, writes speeds and
 * road-event overrides into `traffic.tar`, and records what it applied for
 * routers to read. It renews its lease early when the next scheduled run
 * would come too late.
 */
export function createTrafficLiveService(deps: TrafficLiveServiceDeps) {
  const { options, log, openConditionsUrl, openConditionsRequest } = deps;
  const trafficTarPath =
    options.trafficTarPath ??
    envString("TRAFFIC_TAR_PATH", join(deps.dataDir, "valhalla", "osm-pbf", "traffic.tar"));

  const fetchLiveTrafficCsv =
    options.fetchLiveTrafficCsv ??
    (async (): Promise<string> => {
      const res = await fetchWithTimeout(
        `${openConditionsUrl}/segments/speed.csv`,
        TRAFFIC_LIVE_FETCH_TIMEOUT_MS,
        openConditionsRequest,
      );
      if (!res.ok) {
        throw new Error(`traffic-live: OpenConditions speed feed responded ${res.status}`);
      }
      return readBoundedResponseText(res, 32 * 1024 * 1024, {
        label: "OpenConditions traffic snapshot",
      });
    });

  const loadCoveredWaysToEdges = options.loadWaysToEdges ?? (() => loadWaysToEdgesDefault());
  const trafficWriter = createLiveTrafficWriter({
    onFailure: (error) => {
      log.warn("traffic-live: writer terminated; owner restart required", { error });
      options.onTrafficWriterFailure?.(error);
    },
  });
  const writeLive = options.writeLiveTraffic ?? trafficWriter.write;
  const roadConditionsMode =
    options.roadConditionsMode ??
    (envString("TRAFFIC_ROAD_CONDITIONS_MODE", "shadow") === "active" ? "active" : "shadow");
  const trafficLiveStatePath =
    options.trafficLiveStatePath ?? join(deps.dataDir, "traffic", "live-state.json");
  const trafficEvidenceFile =
    options.trafficEvidencePath ?? resolveTrafficEvidencePath(trafficLiveStatePath);

  const conditionsStaleMs =
    options.trafficConditionsStaleMs ?? envInt("TRAFFIC_CONDITIONS_STALE_MS", 600_000);
  const fetchConditionsJson =
    options.fetchConditionsJson ??
    (async (): Promise<string> => {
      const res = await fetchWithTimeout(
        `${openConditionsUrl}/segments/conditions.json`,
        TRAFFIC_LIVE_FETCH_TIMEOUT_MS,
        openConditionsRequest,
      );
      if (!res.ok) {
        throw new Error(`traffic-live: OpenConditions conditions feed responded ${res.status}`);
      }
      return readBoundedResponseText(res, 32 * 1024 * 1024, {
        label: "OpenConditions traffic snapshot",
      });
    });

  // Last good conditions set, reused across a failing fetch for at most
  // `conditionsStaleMs` so one OpenConditions hiccup does not reopen every
  // closed road for a cycle; after that the closures are dropped and the
  // applied set below empties, so routes make no claim of applied traffic.
  let lastConditions: {
    conditions: BoundCondition[];
    resolverVersion: string | null;
    fetchedAt: number;
  } | null = null;
  let trafficConditionsApplied: TrafficApplicationSnapshot = {
    schemaVersion: 1,
    mode: roadConditionsMode,
    writeId: null,
    engineBootId: null,
    providerId: "routing-valhalla",
    graphGeneration: null,
    policyRevision: null,
    validUntil: null,
    receipts: [],
    writtenAt: null,
    observationIds: [],
    resolverVersion: null,
  };
  // The last policy lease a cycle read, for request-time planned closures.
  let lastPolicy: TrafficPolicy | null = null;
  let lastMissingWaysRefreshAt = 0;

  const valhallaUrl =
    options.valhallaUrl ?? envString("TRAFFIC_VALHALLA_URL", "http://openmapx-valhalla:8002");
  const spanEdgeCachePath =
    options.spanEdgeCachePath ?? join(deps.dataDir, "traffic", "span-edges-cache.json");
  const traceSpan = options.traceSpanEdges ?? traceSpanEdgesDefault;
  // Read from disk once, on the first cycle after boot; every later cycle
  // works on this in-memory map and rewrites the file from it.
  let spanEdgeCache: SpanEdgeCache | null = null;

  // Never rejects: a conditions failure must degrade the closures, not the
  // live-speed write that shares this cycle.
  const currentConditions = async (): Promise<BoundCondition[]> => {
    try {
      const parsed = parseConditionsJson(await fetchConditionsJson());
      lastConditions = { ...parsed, fetchedAt: Date.now() };
      try {
        await recordTrafficConditionsSuccess(trafficEvidenceFile);
      } catch (evidenceErr) {
        log.warn("traffic-live: conditions evidence write failed", {
          err: (evidenceErr as Error).message,
        });
      }
    } catch (err) {
      try {
        await recordTrafficConditionsFailure(trafficEvidenceFile, err);
      } catch (evidenceErr) {
        log.warn("traffic-live: conditions failure evidence write failed", {
          err: (evidenceErr as Error).message,
        });
      }
      if (lastConditions && Date.now() - lastConditions.fetchedAt <= conditionsStaleMs) {
        log.warn("traffic-live: conditions fetch failed, reusing last good set", {
          err: (err as Error).message,
        });
      } else {
        lastConditions = null;
        log.warn("traffic-live: conditions fetch failed and last set is stale, dropping closures", {
          err: (err as Error).message,
        });
      }
    }
    return lastConditions?.conditions ?? [];
  };

  // The writer's own module owns the covered-way-id staleness state; this
  // service just wires fetch → load → write together and logs the match rate.
  // A falling matched/total ratio over time signals OSM-vintage drift
  // between OpenConditions' spine and this deployment's Valhalla graph.
  let trafficLiveRunning = false;
  let leaseRenewal: NodeJS.Timeout | null = null;
  // Runs the next cycle early when this lease would lapse before the next
  // scheduled tick could renew it. Without a schedule there is no cadence to
  // fall behind.
  const scheduleLeaseRenewal = (leaseEnd: number) => {
    if (leaseRenewal) clearTimeout(leaseRenewal);
    leaseRenewal = null;
    const nextTick = deps.nextScheduledRun();
    const renewAt = leaseEnd - TRAFFIC_LEASE_RENEWAL_MS;
    if (nextTick === undefined || renewAt >= nextTick) return;
    leaseRenewal = setTimeout(
      () => {
        leaseRenewal = null;
        void runTrafficLive().catch((err) => {
          log.error("traffic-live: lease renewal threw", { err: (err as Error).message });
        });
      },
      Math.max(0, renewAt - Date.now()),
    );
    leaseRenewal.unref?.();
  };

  const runTrafficLive = async (): Promise<void> => {
    if (trafficLiveRunning) {
      log.info("traffic-live: previous cycle still running, skipped");
      return;
    }
    trafficLiveRunning = true;
    try {
      await runLocalDataExecution({ kind: "traffic-live" }, runTrafficLiveCycle, {
        trigger: "cron",
      });
    } catch (err) {
      log.error("traffic-live: cycle did not run", { err: (err as Error).message });
    } finally {
      trafficLiveRunning = false;
    }
  };

  const runTrafficLiveCycle = async (): Promise<void> => {
    if (!openConditionsUrl) {
      log.info("traffic-live: skipped (OPENCONDITIONS_URL not configured)");
      return;
    }
    try {
      const conditionsPromise = currentConditions();
      let csv = "way_id,dir,current_kph,free_flow_kph,los\n";
      let flowValidated = false;
      try {
        csv = await fetchLiveTrafficCsv();
        flowValidated = true;
      } catch (err) {
        try {
          await recordTrafficFlowFailure(trafficEvidenceFile, err);
        } catch (evidenceErr) {
          log.warn("traffic-live: flow failure evidence write failed", {
            err: (evidenceErr as Error).message,
          });
        }
        log.warn("traffic-live: flow unavailable; reconciling conditions independently");
      }
      try {
        if (flowValidated) await recordTrafficFlowSuccess(trafficEvidenceFile);
      } catch (evidenceErr) {
        log.warn("traffic-live: flow evidence write failed", {
          err: (evidenceErr as Error).message,
        });
      }
      const conditions = await conditionsPromise;
      const conditionsDeadline = lastConditions
        ? lastConditions.fetchedAt + conditionsStaleMs
        : null;
      let policy: TrafficPolicy | null = null;
      try {
        policy = await (options.fetchTrafficPolicy ?? fetchTrafficPolicy)();
        lastPolicy = policy;
      } catch {
        lastPolicy = null;
        log.warn("traffic-live: policy authority unavailable; withholding road-event effects");
      }
      let waysToEdges = new Map<number, WayEdge[]>();
      // Set when the engine's graph cannot be attested: every live effect waits.
      let graphUnattested = false;
      let engineGeneration: string | undefined;
      let engineBootId: string | undefined;
      const captureGraphState = async () => {
        return (
          options.readTrafficGraphState ?? (() => readTrafficGraphState(dirname(trafficTarPath)))
        )();
      };
      try {
        // Bracket the map read: a maintenance completion must never pair old
        // graph IDs with a new engine epoch. The writer checks again under lock.
        const before = await captureGraphState();
        try {
          waysToEdges = await loadCoveredWaysToEdges();
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          log.info("traffic-live: way-to-edge map unavailable; clearing prior effects");
        }
        const after = await captureGraphState();
        if (before.generation !== after.generation || before.engineBootId !== after.engineBootId)
          throw new Error("Traffic graph changed while loading edge map");
        engineGeneration = after.generation;
        engineBootId = after.engineBootId;
      } catch {
        log.warn(
          "traffic-live: graph generations unavailable or changed; withholding live effects",
        );
        waysToEdges = new Map();
        policy = null;
        graphUnattested = true;
        csv = "way_id,dir,current_kph,free_flow_kph,los\n";
        deps.scheduleGraphMaintenanceCheck();
      }
      const hostGraphGeneration = createHash("sha256")
        .update(JSON.stringify([engineGeneration, [...waysToEdges]]))
        .digest("hex");
      for (const c of conditions)
        c.cacheGeneration = `${hostGraphGeneration}:${c.routingEvidence.graph_generation}:${c.routingEvidence.record_revision}`;
      // Failed partial traces remain unapplied; only complete proven spans route.
      let spans: ResolveSpanEdgesResult | null = null;
      try {
        spanEdgeCache ??= await loadSpanEdgeCache(spanEdgeCachePath);
        const spanDeps: SpanEdgesDeps = { valhallaUrl, waysToEdges, logger: log };
        spans = await resolveSpanEdges(conditions, spanEdgeCache, spanDeps, traceSpan);
      } catch (err) {
        log.warn("traffic-live: span tracing failed; partial spans remain unapplied", {
          err: (err as Error).message,
        });
      }
      // Guarded separately from tracing: classification must never abort the
      // cycle, because skipping `writeLive` would leave the previous cycle's
      // overrides alive in `traffic.tar` with no live speeds refreshed.
      let mapped: ConditionsToEdgesResult = emptyConditionsToEdges();
      // Anything ending before a renewal could replace it is left out now, so
      // no lease this write grants can lapse before the next write.
      const renewBy = Date.now() + TRAFFIC_LEASE_RENEWAL_MS;
      const lasting = conditions.filter((c) => {
        const until = conditionRoutingDecision(c).validUntil;
        return until === null || Date.parse(until) > renewBy;
      });
      // Why no condition was classified at all this cycle, so a quiet cycle
      // never reads as "nothing to close".
      const withheld = graphUnattested
        ? "graph_unattested"
        : !policy
          ? "policy_unavailable"
          : !(Date.parse(policy.validUntil) > renewBy)
            ? "policy_lease_ending"
            : conditionsDeadline === null
              ? "conditions_unavailable"
              : !(conditionsDeadline > renewBy)
                ? "conditions_stale"
                : null;
      try {
        mapped = conditionsToEdges(withheld === null ? lasting : [], waysToEdges, spans?.resolved, {
          disallowedSources: new Set(policy?.disallowedSourceIds ?? []),
          ...(policy?.rightsPolicy ? { rightsPolicy: policy.rightsPolicy } : {}),
        });
      } catch (err) {
        log.warn("traffic-live: conditions classification failed, writing no overrides", {
          err: (err as Error).message,
        });
      }
      if (
        mapped.missingWayIds.size > 0 &&
        Date.now() - lastMissingWaysRefreshAt > MISSING_WAYS_REFRESH_MIN_INTERVAL_MS
      ) {
        lastMissingWaysRefreshAt = Date.now();
        log.info("traffic-live: bound ways missing from way→edge map, scheduling refresh", {
          missing: mapped.missingWayIds.size,
        });
        // Fire-and-forget: a `valhalla_ways_to_edges` run is far slower than a
        // 2-minute cycle, and this cycle's write must not wait on it.
        void deps.refreshWaysToEdges();
      }
      // Live speeds alone hold the full lease. Written road-event overrides
      // also hold it to the policy, the conditions set and each contributing
      // effect's own deadline.
      const overrides = roadConditionsMode === "active" ? mapped.overrides : new Map();
      const contributors = new Set(
        [...overrides.values()].flatMap((o) => [o.observationId, ...(o.contributorIds ?? [])]),
      );
      const overrideDeadlines =
        overrides.size === 0
          ? []
          : [
              ...(policy ? [Date.parse(policy.validUntil)] : []),
              ...(conditionsDeadline !== null ? [conditionsDeadline] : []),
              ...conditions
                .filter((c) => contributors.has(c.id))
                .flatMap((c) => {
                  const decision = conditionRoutingDecision(
                    c,
                    policy?.rightsPolicy ? { rightsPolicy: policy.rightsPolicy } : {},
                  );
                  return decision.eligible && decision.validUntil
                    ? [Date.parse(decision.validUntil)]
                    : [];
                }),
            ];
      const validUntil = new Date(
        Math.min(Date.now() + TRAFFIC_LEASE_MAX_MS, ...overrideDeadlines),
      ).toISOString();
      const writeId = randomUUID();
      const result = await writeLive({
        writeId,
        engineBootId,
        tarPath: trafficTarPath,
        validUntil,
        graphGeneration: hostGraphGeneration,
        expectedGraphGeneration: options.readTrafficGraphState ? undefined : engineGeneration,
        csv,
        waysToEdges,
        overrides,
        statePath: trafficLiveStatePath,
        evidencePath: trafficEvidenceFile,
        logger: log,
      });
      scheduleLeaseRenewal(Date.parse(validUntil));
      // The default writer records this itself so direct writer invocations
      // also leave evidence. Custom writers use the same bounded result here.
      if (options.writeLiveTraffic) {
        try {
          await recordTrafficGraphSuccess(trafficEvidenceFile, result);
        } catch (evidenceErr) {
          log.warn("traffic-live: graph evidence write failed", {
            err: (evidenceErr as Error).message,
          });
        }
      }
      // Sourced from the WRITER, not from `mapped`: an observation whose every
      // edge failed to resolve was requested but never written, and claiming it
      // here would make a router skip an exclusion for a road that is still open.
      trafficConditionsApplied = {
        schemaVersion: 1,
        mode: roadConditionsMode,
        writeId,
        engineBootId: engineBootId ?? null,
        providerId: "routing-valhalla",
        graphGeneration: hostGraphGeneration,
        policyRevision: policy?.revision ?? null,
        validUntil,
        receipts: policy
          ? buildTrafficReceipts({
              conditions,
              overrides: mapped.overrides,
              appliedObservationIds: result.appliedObservationIds,
              graphGeneration: hostGraphGeneration,
              policyRevision: policy.revision,
              rightsPolicy: policy.rightsPolicy,
              validUntil,
            })
          : [],
        writtenAt: new Date().toISOString(),
        observationIds: result.appliedObservationIds,
        resolverVersion: lastConditions?.resolverVersion ?? null,
      };
      log.info("traffic-live: conditions applied", {
        mode: roadConditionsMode,
        candidateEdges: mapped.overrides.size,
        closedEdges: result.closedEdges,
        cappedEdges: result.cappedEdges,
        overridesUnresolved: result.overridesUnresolved,
        requestedClosures: mapped.appliedObservationIds.size,
        appliedConditions: trafficConditionsApplied.observationIds.length,
        edgeExactSpans: mapped.edgeExactSpans,
        wholeWaySpans: mapped.wholeWaySpans,
        missingWays: mapped.missingWayIds.size,
        skipped: mapped.skipped,
        ineligibleReasons: mapped.ineligibleReasons,
        endingBeforeRenewal: conditions.length - lasting.length,
        withheld,
      });
      if (spans && spanEdgeCache) {
        // An empty set because the FEED is down is not the same as a set with
        // no conditions left: pruning on an outage would throw away every trace
        // and re-trace the lot once OpenConditions returns.
        if (lastConditions) {
          // Keyed on the CURRENT conditions, so a lifted closure's traces leave
          // both the file and this process instead of growing forever — a span
          // key binds the observation id and geometry, so a dropped entry could
          // never be hit again anyway.
          const referenced = new Set(
            conditions.flatMap((c) =>
              c.segments.map((s) =>
                spanKey(c.cacheGeneration ? `${c.cacheGeneration}:${c.id}` : c.id, s),
              ),
            ),
          );
          try {
            await saveSpanEdgeCache(spanEdgeCachePath, spanEdgeCache, referenced);
          } catch (err) {
            log.warn("traffic-live: span cache save failed", { err: (err as Error).message });
          }
          for (const key of spanEdgeCache.keys()) {
            if (!referenced.has(key)) spanEdgeCache.delete(key);
          }
        }
        log.info("traffic-live: span tracing", {
          traced: spans.traced,
          unanswered: spans.unanswered,
          negative: spans.negative,
          skippedBudget: spans.skippedBudget,
          cacheHits: spans.cacheHits,
          edgeExactSpans: mapped.edgeExactSpans,
          wholeWaySpans: mapped.wholeWaySpans,
        });
      }
      const matchRatePct =
        result.total > 0 ? Number(((result.matched / result.total) * 100).toFixed(1)) : null;
      log.info("traffic-live: cycle complete", {
        written: result.written,
        matched: result.matched,
        total: result.total,
        matchRatePct,
        outOfBounds: result.outOfBounds,
      });
      // A non-zero out-of-bounds count means waysToEdges references edges the
      // current traffic.tar doesn't have — a version mismatch the daily
      // extract-guard cron resolves by rebuilding both.
      if (result.outOfBounds > 0) {
        log.warn("traffic-live: skipped out-of-range edges (traffic.tar/waysToEdges mismatch)", {
          outOfBounds: result.outOfBounds,
        });
      }
    } catch (err) {
      log.error("traffic-live: cycle failed", { err: (err as Error).message });
      try {
        await recordTrafficGraphFailure(trafficEvidenceFile, err);
      } catch (evidenceErr) {
        log.warn("traffic-live: evidence failure could not be recorded", {
          err: (evidenceErr as Error).message,
        });
      }
    }
  };

  return {
    /** Run one cycle now; a cycle still running makes this one a no-op. */
    run: runTrafficLive,
    /**
     * `observationIds`: the observations whose EVERY override edge was ACTUALLY
     * written into `traffic.tar` during the last successful live-speed cycle,
     * sorted; `writtenAt`: when that cycle wrote them (null until the first
     * successful write). An observation with even one edge that failed to
     * resolve is absent, because a router treats presence here as "the graph
     * already reflects this event" and reports its shared traffic as applied to
     * a route — a partially-written event would claim protection while its
     * unwritten edges stay open. Cap-only observations are included too: their
     * speed caps are written the same way.
     */
    conditionsApplied: (): TrafficApplicationSnapshot =>
      trafficConditionsApplied.validUntil &&
      Date.parse(trafficConditionsApplied.validUntil) > Date.now()
        ? trafficConditionsApplied
        : { ...trafficConditionsApplied, observationIds: [], receipts: [] },
    /**
     * The bound closures a car trip at `travelAt` must route around, from the
     * last good conditions set under the last policy lease; null when either is
     * stale or absent, so a caller never routes on lapsed evidence.
     */
    plannedClosures: (
      bbox: readonly [number, number, number, number],
      travelAt: number,
    ): PlannedTrafficClosures | null => {
      const now = Date.now();
      const conditionsUntil = lastConditions ? lastConditions.fetchedAt + conditionsStaleMs : 0;
      const policyUntil = lastPolicy ? Date.parse(lastPolicy.validUntil) : Number.NaN;
      if (!lastConditions || !lastPolicy || !(conditionsUntil > now) || !(policyUntil > now))
        return null;
      const { closures, unrepresentable } = plannedClosures(lastConditions.conditions, {
        bbox,
        travelAt,
        evaluatedAt: now,
        disallowedSources: new Set(lastPolicy.disallowedSourceIds),
        ...(lastPolicy.rightsPolicy ? { rightsPolicy: lastPolicy.rightsPolicy } : {}),
      });
      const validUntil = Math.min(
        conditionsUntil,
        policyUntil,
        ...closures.map((c) => Date.parse(c.validUntil)),
      );
      return {
        schemaVersion: 1,
        mode: roadConditionsMode,
        evaluatedAt: new Date(now).toISOString(),
        at: new Date(travelAt).toISOString(),
        policyRevision: lastPolicy.revision,
        validUntil: new Date(validUntil).toISOString(),
        closures,
        unrepresentable,
      };
    },
    /** Drain the owned live writer, then wait for thread exit. */
    closeWriter: (): Promise<void> => trafficWriter.close(),
    /** Cancel a pending early lease renewal. */
    stop: (): void => {
      if (leaseRenewal) clearTimeout(leaseRenewal);
    },
  };
}

export type TrafficLiveService = ReturnType<typeof createTrafficLiveService>;
