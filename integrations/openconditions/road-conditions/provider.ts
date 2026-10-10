import type { BBox, RoadConditionRoutingEvidence } from "@openmapx/core";
import type {
  RoadConditionEvent,
  RoadConditionsProvider,
  RoadConditionsQuery,
} from "@openmapx/integration-framework";
import type { OpenConditionsClient } from "../client.js";
import { operationalEvidenceOf, type RawOperationalStatus } from "../evidence/read.js";
import type { LiveSources } from "../sources.js";
import { featureCollectionToRoadFlowSegments } from "./flow.js";
import { situationToRoadConditionEvent } from "./situation.js";

const PROVIDER_ID = "road-conditions-openconditions";
/** A display read stops after this many situations; a routing read reads them all. */
const DISPLAY_MAX = 2000;
const DISPLAY_PAGE = 1000;
const ROUTING_PAGE = 5000;

type Rec = Record<string, unknown>;

type SituationPage = { records?: unknown; next?: unknown };

type SegmentConditionEvidenceResponse = {
  schema_version?: unknown;
  complete?: unknown;
  conditions?: Array<{ routing_evidence?: RoadConditionRoutingEvidence }>;
};

/** Whether a record comes from a source, or a catalogue child of a source, the deployment excluded. */
function excluded(record: Rec, sources: ReadonlySet<string>): boolean {
  const provenance = (record["provenance"] ?? {}) as Rec;
  const attribution = (provenance["attribution"] ?? {}) as Rec;
  return (
    sources.has(String(provenance["sourceId"])) ||
    sources.has(String(attribution["parentSourceId"] ?? ""))
  );
}

/**
 * Whether a record may be served under the live source list: a feed record
 * whose source, or whose catalogue child's parent, is listed. Records of
 * other origins (crowd reports, federated and derived records) are not feeds
 * and are not in the list.
 */
function listed(record: Rec, sources: LiveSources): boolean {
  const provenance = (record["provenance"] ?? {}) as Rec;
  const origin = provenance["origin"];
  if (origin !== undefined && origin !== "feed") return true;
  const attribution = (provenance["attribution"] ?? {}) as Rec;
  const parent = attribution["parentSourceId"];
  return (
    sources.has(String(provenance["sourceId"])) ||
    (typeof parent === "string" && sources.has(parent))
  );
}

/**
 * A `road-conditions` provider backed by the OpenConditions record API:
 * situations from `GET /situations`, their routing evidence from
 * `GET /segments/conditions.json`, flow from `GET /segments.geojson` and
 * operational evidence from `GET /feeds/status`. The `road-conditions`
 * orchestrator merges it with any other providers and serves the result to
 * the overlay and navigation.
 *
 * It fails closed on the live source list: until the first list arrives a
 * display or flow read is empty and a routing read rejects, as it does when
 * OpenConditions is down; after it, a feed record whose source is not
 * listed is left out.
 */
export function createRoadConditionsProvider(
  client: OpenConditionsClient,
  sources: LiveSources,
): RoadConditionsProvider {
  /**
   * The situations in `bbox`, page after page until `next` is null. A display
   * read stops at `DISPLAY_MAX`; a routing read reads every page, and any page
   * that fails or does not parse fails the whole read.
   */
  async function readSituations(
    bbox: BBox,
    opts: RoadConditionsQuery | undefined,
    routing: boolean,
  ): Promise<Rec[]> {
    const records: Rec[] = [];
    let cursor: string | null = null;
    do {
      const page: SituationPage = await client.get<SituationPage>(
        "/situations",
        {
          bbox: bbox.join(","),
          limit: routing ? ROUTING_PAGE : DISPLAY_PAGE,
          ...(opts?.kinds?.length ? { kind: opts.kinds.join(",") } : {}),
          ...(opts?.excludeKinds?.length ? { excludeKind: opts.excludeKinds.join(",") } : {}),
          ...(opts?.types?.length ? { type: opts.types.join(",") } : {}),
          ...(opts?.minSeverity ? { minSeverity: opts.minSeverity } : {}),
          // Only narrow when the caller asked: routing reads unfiltered so it
          // can evaluate future closures at the chosen travel time.
          ...(opts?.horizonDays != null ? { horizonDays: opts.horizonDays } : {}),
          ...(cursor !== null ? { cursor } : {}),
        },
        routing ? { timeoutMs: 5000, maxResponseBytes: 64 * 1024 * 1024 } : undefined,
      );
      if (!Array.isArray(page.records) || (page.next !== null && typeof page.next !== "string")) {
        throw new Error("Malformed situation page");
      }
      records.push(...(page.records as Rec[]));
      cursor = page.next as string | null;
    } while (cursor !== null && (routing || records.length < DISPLAY_MAX));
    const without = new Set(opts?.excludedSourceIds ?? []);
    return records.filter((r) => listed(r, sources) && !excluded(r, without));
  }

  /**
   * The events of `records`, each with an evidence map that starts empty.
   * OpenConditions publishes routing evidence for every effect it binds, so an
   * effect without an entry is unbound, stale or not licensed for routing: the
   * host must not stand in its raw geometry for a binding.
   */
  function eventsOf(records: readonly Rec[]): RoadConditionEvent[] {
    return records.flatMap((record) => {
      const event = situationToRoadConditionEvent(record, PROVIDER_ID, sources);
      return event ? [{ ...event, routingEvidence: {} }] : [];
    });
  }

  /**
   * The situations of `records` with the routing evidence of their effects.
   * The evidence is read after the situations, so a situation that changed in
   * between fails a strict read rather than routing on stale evidence; a
   * display read keeps the situation and leaves its evidence out. Both reads
   * match a situation by its own place or any of its effects', so evidence of
   * a situation the walk did not return names one that appeared after the
   * walk; it is left out and routes from the next read.
   */
  async function withEvidence(
    bbox: BBox,
    records: readonly Rec[],
    strict: boolean,
  ): Promise<RoadConditionEvent[]> {
    const snapshot = await client.get<SegmentConditionEvidenceResponse>(
      "/segments/conditions.json",
      { bbox: bbox.join(",") },
      strict ? { timeoutMs: 2000, maxResponseBytes: 32 * 1024 * 1024 } : undefined,
    );
    if (
      snapshot.schema_version !== 2 ||
      snapshot.complete !== true ||
      !Array.isArray(snapshot.conditions)
    ) {
      throw new Error("Incomplete routing evidence snapshot");
    }
    const byId = new Map(records.map((r) => [String(r["id"]), r]));
    const events = new Map(eventsOf(records).map((e) => [e.id, e]));
    const changed = new Set<string>();
    for (const condition of snapshot.conditions) {
      const evidence = condition.routing_evidence;
      if (evidence == null) continue;
      const record = byId.get(evidence.record_id);
      const event = events.get(evidence.record_id);
      if (record === undefined || event === undefined) continue;
      const current =
        record["revision"] === evidence.record_revision &&
        event.effects.some((effect) => effect.id === evidence.effect_id);
      if (!current) {
        if (strict) throw new Error(`Situation changed during routing read: ${evidence.record_id}`);
        changed.add(event.id);
        continue;
      }
      event.routingEvidence = { ...event.routingEvidence, [evidence.effect_id]: evidence };
    }
    // A display read never attaches part of a changed situation's evidence.
    for (const id of changed) {
      const event = events.get(id);
      if (event) event.routingEvidence = {};
    }
    return [...events.values()];
  }

  return {
    id: PROVIDER_ID,
    /**
     * A display read: the situations, with their routing evidence when it can
     * be read. Evidence is optional here; the situations stay available while
     * the evidence read recovers.
     */
    async getEvents(bbox, opts) {
      if (!sources.ready) return [];
      const records = await readSituations(bbox, opts, false);
      try {
        return await withEvidence(bbox, records, false);
      } catch {
        return eventsOf(records);
      }
    },
    async getRoutingEvents(bbox) {
      if (!sources.ready) throw new Error("OpenConditions source list not read yet");
      const records = await readSituations(bbox, undefined, true);
      return { complete: true, events: await withEvidence(bbox, records, true) };
    },
    /** Flow is fused across sources and carries none; it is held back only until the first list. */
    async getFlow(bbox) {
      if (!sources.ready) return [];
      const body = await client.get<unknown>("/segments.geojson", { bbox: bbox.join(",") });
      return featureCollectionToRoadFlowSegments(body, PROVIDER_ID);
    },
    /** The road feeds' polls and publications, judged with the segment graph they bind to. */
    async getOperationalEvidence() {
      const raw = await client.get<RawOperationalStatus>("/feeds/status");
      return operationalEvidenceOf(raw, "roads", { graphBound: true });
    },
  };
}
