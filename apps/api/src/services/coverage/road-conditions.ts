import { type StreamEvidence, streamEvidenceSchema } from "@openmapx/core/coverage";
import type { RoadConditionsOperationalEvidence } from "@openmapx/integration-framework";

const safeText = (value: string | null): string | null =>
  value === null
    ? null
    : value
        .replace(/https?:\/\/\S+/gi, "[source endpoint]")
        .replace(/(?:token|key|secret|password|authorization)\s*[=:]\s*\S+/gi, "[redacted]")
        .slice(0, 512);

export function roadConditionStreams(
  owner: string,
  snapshot: RoadConditionsOperationalEvidence,
): StreamEvidence[] {
  if (snapshot.schemaVersion !== 1 || snapshot.feeds.length > 500)
    throw new Error("Invalid road-condition operational snapshot");
  return snapshot.feeds.map((feed) => {
    const last = feed.lastOutcome ?? "unknown";
    const outcome = last.includes("skip")
      ? "skipped"
      : last.includes("partial")
        ? "partial"
        : last.includes("fail")
          ? "failed"
          : last.includes("unchanged")
            ? "unchanged"
            : ["changed", "empty", "succeeded", "success", "complete_empty"].includes(last)
              ? "succeeded"
              : "unknown";
    return streamEvidenceSchema.parse({
      key: `road-conditions:${owner}:${snapshot.instanceId}:${feed.sourceId}`,
      owner: { kind: "integration", id: owner },
      sourceId: feed.sourceId,
      attributionSourceId: feed.sourceId,
      consumerInstance: snapshot.instanceId,
      domain: "traffic",
      stream: "road-conditions",
      evidenceVersion: 1,
      observedAt: snapshot.collectedAt,
      presence:
        feed.activeEventCount === null
          ? "unknown"
          : feed.activeEventCount === 0
            ? "empty"
            : "present",
      region: {
        keys: feed.graph.regions,
        basis: feed.graph.status === "ready" ? "observed" : "declared",
        relation: "unknown",
      },
      ...(feed.activeEventCount === null
        ? {}
        : {
            count: {
              value: feed.activeEventCount,
              unit: "events",
              scope: "active source observations at evaluation time",
            },
          }),
      publication: {
        version: feed.publicationRevision,
        publishedAt: feed.lastPublicationAt,
        active: feed.publicationRevision ? true : null,
      },
      attempt: {
        at: feed.lastAttemptAt,
        outcome,
        ...(feed.error ? { message: safeText(feed.error) } : {}),
      },
      lastSuccessfulCheckAt: feed.lastSuccessfulCheckAt,
      lastSuccessfullyCheckedVersion: feed.publicationRevision,
      upstreamAsOf: feed.upstreamAsOf,
      expiresAt: feed.freshUntil,
      policy: {
        basis: "validated-source-snapshot",
        expectedIntervalSeconds: feed.expectedIntervalSeconds,
        staleAt: feed.freshUntil,
        expiresAt: feed.freshUntil,
        version: "road-conditions-v1",
        provenance: "OpenConditions durable feed status",
      },
      freshness: "unknown",
      reasons: feed.graph.status === "ready" ? [] : ["region_unknown"],
      roadConditions: {
        status: feed.status,
        action: safeText(feed.action),
        changedCount: feed.changedCount,
        rejectedCount: feed.rejectedCount,
        consecutiveFailures: feed.consecutiveFailures,
        bindingCounts: feed.bindingCounts,
        graph: feed.graph,
      },
    });
  });
}
