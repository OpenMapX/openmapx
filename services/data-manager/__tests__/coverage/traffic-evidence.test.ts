import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadTrafficEvidence,
  MAX_TRAFFIC_EVIDENCE_BYTES,
  recordTrafficConditionsSuccess,
  recordTrafficFlowSuccess,
  recordTrafficGraphFailure,
  recordTrafficGraphSuccess,
  trafficEvidencePath,
} from "../../src/jobs/traffic/evidence.js";

describe("traffic publication evidence", () => {
  it("keeps independent streams, valid empty writes, and the historical file across reloads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-traffic-evidence-"));
    const statePath = join(directory, "live-state.json");
    const path = trafficEvidencePath(statePath);
    try {
      writeFileSync(statePath, JSON.stringify({ observationIds: ["runtime-only"] }), "utf8");
      await Promise.all([
        recordTrafficFlowSuccess(path, "2026-09-10T12:00:00.000Z"),
        recordTrafficConditionsSuccess(
          path,
          { upstreamAsOf: "2026-09-10T11:55:00.000Z", expiresAt: "2026-09-10T13:00:00.000Z" },
          "2026-09-10T12:00:01.000Z",
        ),
        recordTrafficGraphSuccess(
          path,
          { total: 0, matched: 0, written: 0, outOfBounds: 0 },
          "2026-09-10T12:00:02.000Z",
        ),
      ]);

      const loaded = await loadTrafficEvidence(path);
      expect(loaded.status).toBe("ok");
      if (loaded.status !== "ok") return;
      expect(loaded.evidence.flow.lastSuccessfulCheckAt).toBe("2026-09-10T12:00:00.000Z");
      expect(loaded.evidence.conditions.upstreamAsOf).toBe("2026-09-10T11:55:00.000Z");
      expect(loaded.evidence.graph).toMatchObject({
        total: 0,
        written: 0,
        graphApplied: true,
        lastPublishedAt: "2026-09-10T12:00:02.000Z",
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);

      await recordTrafficGraphFailure(path, new Error("writer failed"), "2026-09-10T12:01:00.000Z");
      const afterFailure = await loadTrafficEvidence(path);
      expect(afterFailure.status).toBe("ok");
      if (afterFailure.status !== "ok") return;
      expect(afterFailure.evidence.graph.lastAttemptOutcome).toBe("failed");
      expect(afterFailure.evidence.graph.lastSuccessfulCheckAt).toBe("2026-09-10T12:00:02.000Z");
      expect(afterFailure.evidence.graph.lastPublishedAt).toBe("2026-09-10T12:00:02.000Z");

      // A historical sidecar observation is not a runtime applied-observation
      // set. Restarting the reader therefore leaves live-state.json untouched.
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
        observationIds: ["runtime-only"],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes a missing sidecar from a corrupt one", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-traffic-evidence-state-"));
    const path = join(directory, "publication-evidence.json");
    try {
      await expect(loadTrafficEvidence(path)).resolves.toMatchObject({ status: "missing" });
      writeFileSync(path, "{not-json", "utf8");
      await expect(loadTrafficEvidence(path)).resolves.toMatchObject({ status: "corrupt" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an oversized sidecar before parsing it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-traffic-evidence-large-"));
    const path = join(directory, "publication-evidence.json");
    try {
      writeFileSync(path, "x".repeat(MAX_TRAFFIC_EVIDENCE_BYTES + 1), "utf8");
      await expect(loadTrafficEvidence(path)).resolves.toMatchObject({ status: "corrupt" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
