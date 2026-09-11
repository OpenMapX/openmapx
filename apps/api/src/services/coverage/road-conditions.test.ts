import { describe, expect, it } from "vitest";
import { roadConditionStreams } from "./road-conditions.js";

const feed = {
  sourceId: "wzdx-kansas",
  parentSourceId: "us-wzdx",
  lastAttemptAt: "2026-09-11T12:00:00Z",
  lastOutcome: "skipped_cadence",
  lastSuccessfulCheckAt: "2026-09-11T11:59:00Z",
  lastPublicationAt: "2026-09-11T11:58:00Z",
  publicationRevision: "p1",
  upstreamAsOf: null,
  freshUntil: "2026-09-11T12:10:00Z",
  expectedIntervalSeconds: 300,
  activeEventCount: 42,
  changedCount: 0,
  rejectedCount: 0,
  consecutiveFailures: 0,
  error: null,
  bindingCounts: { exact: 40, unresolved: 2 },
  graph: { generation: null, status: "missing" as const, regions: ["US-KS"] },
  status: "skipped_cadence",
  action: "Import selected graph",
};
describe("road-condition operational evidence adapter", () => {
  it("keeps event stock and successful network check distinct from cadence skips", () => {
    const [stream] = roadConditionStreams("oc", {
      schemaVersion: 1,
      instanceId: "i1",
      collectedAt: "2026-09-11T12:00:00Z",
      feeds: [feed],
    });
    expect(stream!.count?.value).toBe(42);
    expect(stream!.lastSuccessfulCheckAt).toBe("2026-09-11T11:59:00Z");
    expect(stream!.roadConditions?.graph.status).toBe("missing");
    expect(stream!.roadConditions?.bindingCounts).toEqual({ exact: 40, unresolved: 2 });
    expect(stream!.sourceId).toBe("wzdx-kansas");
  });
  it("does not expose upstream URL credentials in errors or invent counts", () => {
    const [stream] = roadConditionStreams("oc", {
      schemaVersion: 1,
      instanceId: "i1",
      collectedAt: "2026-09-11T12:00:00Z",
      feeds: [
        {
          ...feed,
          activeEventCount: null,
          error: "Failed https://user:secret@host/path?token=secret",
        },
      ],
    });
    expect(stream!.count).toBeUndefined();
    expect(JSON.stringify(stream)).not.toContain("secret");
  });
});
