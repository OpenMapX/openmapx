import {
  getRoadConditionRoutingDecision,
  type RoadConditionEvent,
  type RoadConditionRouteImpact,
  type Route,
  type RoutingTrafficProof,
  type TrafficApplicationSnapshot,
} from "@openmapx/core";
import { services as coreServices } from "@openmapx/core/server";
import { envString } from "@openmapx/core/server-env";
import type { IntegrationContext, RoadConditionsProvider } from "@openmapx/integration-framework";
import { assessRoadConditionForRoute } from "./road-condition-routing.js";

export function receiptCoversEvent(
  event: RoadConditionEvent,
  snapshot: TrafficApplicationSnapshot,
  proof: RoutingTrafficProof,
  disallowed: ReadonlySet<string>,
  now: number,
): boolean {
  const e = event.routingEvidence;
  if (
    !e ||
    !getRoadConditionRoutingDecision(event, {
      evaluatedAt: now,
      travelAt: now,
      disallowedSources: disallowed,
      sharedTraffic: true,
    }).eligible
  )
    return false;
  return snapshot.receipts.some(
    (r) =>
      r &&
      r.observationId === event.id &&
      r.observationRevision === e.observation_revision &&
      r.sourceId === event.source &&
      r.sourceGraphGeneration === e.graph_generation &&
      r.graphGeneration === proof.graphGeneration &&
      r.policyRevision === snapshot.policyRevision &&
      r.complete === true &&
      r.effect ===
        (event.speedLimitKph != null &&
        event.roadState !== "closed" &&
        event.type !== "road_closure"
          ? "speed_cap"
          : "closure") &&
      Date.parse(r.validUntil) > now &&
      Array.isArray(r.edgeKeys) &&
      r.edgeKeys.length > 0 &&
      JSON.stringify(r.intendedSpans) === JSON.stringify(e.segments) &&
      r.sourceLicense === e.source_license &&
      r.attribution === e.attribution,
  );
}

export function snapshotMatchesProof(
  snapshot: TrafficApplicationSnapshot | null,
  proof: RoutingTrafficProof,
  now: number,
): snapshot is TrafficApplicationSnapshot {
  return Boolean(
    snapshot &&
      proof.schemaVersion === 1 &&
      (proof.costing === "auto" || proof.costing === "motorcycle") &&
      (proof.endpoint === "route" || proof.endpoint === "optimized_route") &&
      typeof proof.requestId === "string" &&
      proof.requestId.length > 0 &&
      snapshot.schemaVersion === 1 &&
      snapshot.mode === "active" &&
      snapshot.providerId === "routing-valhalla" &&
      snapshot.writeId &&
      snapshot.writeId === proof.writeId &&
      snapshot.engineBootId &&
      snapshot.engineBootId === proof.engineBootId &&
      snapshot.graphGeneration === proof.graphGeneration &&
      snapshot.policyRevision &&
      Array.isArray(snapshot.receipts) &&
      snapshot.receipts.length <= 100_000 &&
      snapshot.receipts.every(
        (r) =>
          r && typeof r === "object" && Array.isArray(r.edgeKeys) && Array.isArray(r.intendedSpans),
      ) &&
      Date.parse(snapshot.validUntil ?? "") > now &&
      Date.parse(proof.validUntil) > now &&
      Date.parse(snapshot.writtenAt ?? "") <= Date.parse(proof.evaluatedAt) &&
      Date.parse(proof.evaluatedAt) <= now,
  );
}

async function readSnapshot(ctx: IntegrationContext): Promise<TrafficApplicationSnapshot | null> {
  try {
    const token = envString("DATA_MANAGER_AUTH_TOKEN", "").trim();
    if (!token) return null;
    const base = coreServices.validateDataManagerBaseUrl(
      ctx.getRequiredService("data-manager")?.url ??
        envString("DATA_MANAGER_URL", "http://localhost:4000"),
    );
    return await ctx.http.get<TrafficApplicationSnapshot>(`${base}/traffic/conditions/applied`, {
      timeoutMs: 2_000,
      maxResponseBytes: 8 * 1024 * 1024,
      cache: { ttl: 0 },
      headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-cache" },
    });
  } catch {
    return null;
  }
}

/** Reconcile the actual returned routes with fresh writer and source evidence. */
async function reconcileRouteTraffic(
  ctx: IntegrationContext,
  routes: Route[],
  fallback: RoadConditionRouteImpact | undefined,
  providerId: string | undefined,
): Promise<RoadConditionRouteImpact | undefined> {
  if (providerId !== "routing-valhalla") return fallback;
  if (
    !fallback ||
    !routes.length ||
    routes.some((r) => !r.trafficProof || (r.mode !== "driving" && r.mode !== "motorcycle"))
  )
    return fallback;
  const proofs = routes.map((r) => r.trafficProof as RoutingTrafficProof);
  const snapshot = await readSnapshot(ctx);
  let now = Date.now();
  if (!snapshot || proofs.some((p) => !snapshotMatchesProof(snapshot, p, now))) return fallback;
  const coords = routes.flatMap((r) => r.geometry);
  if (!coords.length) return fallback;
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of coords) {
    bbox[0] = Math.min(bbox[0], lon - 0.05);
    bbox[1] = Math.min(bbox[1], lat - 0.05);
    bbox[2] = Math.max(bbox[2], lon + 0.05);
    bbox[3] = Math.max(bbox[3], lat + 0.05);
  }
  const providers = ctx
    .getIntegrationsByDomain("road-conditions")
    .flatMap((i) => (i.providers.get("road-conditions") ?? []) as RoadConditionsProvider[]);
  if (!providers.length) return fallback;
  const settled = await Promise.allSettled(
    providers.map(async (p) => {
      if (!p.getRoutingEvents) throw new Error("Complete routing observations unavailable");
      const result = await p.getRoutingEvents(bbox);
      if (
        result?.complete !== true ||
        !Array.isArray(result.events) ||
        result.events.length > 100_000
      )
        throw new Error("Incomplete routing observations");
      return result.events;
    }),
  );
  const policy = await ctx.getRoadConditionsPolicySnapshot?.();
  if (
    !policy?.authoritative ||
    policy.revision !== snapshot.policyRevision ||
    !(Date.parse(policy.validUntil ?? "") > Date.now())
  )
    return fallback;
  const disallowed = new Set([
    ...policy.disallowedSourceIds,
    ...((await ctx.getDisallowedSourceIds?.()) ?? []),
  ]);
  if (
    snapshot.receipts.some(
      (r) => disallowed.has(r.sourceId) || r.policyRevision !== policy.revision,
    )
  )
    return fallback;
  now = Date.now();
  if (proofs.some((p) => !snapshotMatchesProof(snapshot, p, now))) return fallback;
  // Complete queries may contain far more events than the display list.
  const receiptsById = new Map<string, TrafficApplicationSnapshot["receipts"]>();
  for (const receipt of snapshot.receipts) {
    const entries = receiptsById.get(receipt.observationId) ?? [];
    entries.push(receipt);
    receiptsById.set(receipt.observationId, entries);
  }
  const reasons = new Set<string>();
  const deadlines = [
    Date.parse(policy.validUntil as string),
    Date.parse(snapshot.validUntil as string),
    ...proofs.map((p) => Date.parse(p.validUntil)),
  ];
  for (const result of settled) {
    if (result.status === "rejected") {
      reasons.add("road_condition_provider_unavailable");
      continue;
    }
    for (const event of result.value) {
      const e = event.routingEvidence;
      if (
        disallowed.has(event.source) ||
        (e &&
          (disallowed.has(e.source_id) || (e.child_source_id && disallowed.has(e.child_source_id))))
      )
        continue;
      if (!e) {
        reasons.add("missing_routing_evidence");
        continue;
      }
      const decision = getRoadConditionRoutingDecision(event, {
        evaluatedAt: now,
        travelAt: now,
        disallowedSources: disallowed,
        sharedTraffic: true,
      });
      if (!decision.eligible) {
        for (const reason of decision.reasons) reasons.add(reason);
        continue;
      }
      if (decision.validUntil) deadlines.push(Date.parse(decision.validUntil));
      const eventReceipts = receiptsById.get(event.id) ?? [];
      const eventSnapshot = { ...snapshot, receipts: eventReceipts };
      const covered = proofs.every((p) =>
        receiptCoversEvent(event, eventSnapshot, p, disallowed, now),
      );
      if (!covered) reasons.add("incomplete_engine_application");
      for (const route of routes) {
        const assessment = assessRoadConditionForRoute(event, {
          evaluatedAt: now,
          travelAt: now,
          mode: route.mode,
          sharedTrafficApplied: covered,
          disallowedSources: disallowed,
        });
        for (const reason of assessment.reasons) reasons.add(reason);
      }
      if (covered) {
        for (const r of eventReceipts) deadlines.push(Date.parse(r.validUntil));
      }
    }
  }
  const validUntil = deadlines.reduce(
    (earliest, deadline) => Math.min(earliest, deadline),
    Infinity,
  );
  if (!(validUntil > Date.now())) reasons.add("expired_engine_application");
  return {
    availability: reasons.size ? "limited" : "current",
    evaluatedAt: new Date(now).toISOString(),
    validUntil: Number.isFinite(validUntil) ? new Date(validUntil).toISOString() : null,
    reasons: [...reasons],
  };
}

export async function verifyRouteTraffic(
  ctx: IntegrationContext,
  routes: Route[],
  fallback: RoadConditionRouteImpact | undefined,
  providerId: string | undefined,
): Promise<RoadConditionRouteImpact | undefined> {
  try {
    return await reconcileRouteTraffic(ctx, routes, fallback, providerId);
  } catch {
    return fallback;
  }
}
