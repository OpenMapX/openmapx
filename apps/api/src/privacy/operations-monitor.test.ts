import { describe, expect, it } from "vitest";
import { createDbMock } from "../test/db.js";
import { createPrivacyOperationsMonitor, operationalProbeHealthy } from "./operations-monitor.js";

describe("privacy operational health freshness", () => {
  const now = new Date("2026-09-05T12:00:00Z");

  it("accepts a recent successful probe and rejects stale or malformed evidence", () => {
    expect(
      operationalProbeHealthy({ healthy: true, checkedAt: "2026-09-05T11:59:30Z" }, now, 60_000),
    ).toBe(true);
    expect(
      operationalProbeHealthy({ healthy: true, checkedAt: "2026-09-05T11:58:00Z" }, now, 60_000),
    ).toBe(false);
    expect(operationalProbeHealthy({ healthy: true, checkedAt: "invalid" }, now, 60_000)).toBe(
      false,
    );
    expect(
      operationalProbeHealthy({ healthy: false, checkedAt: "2026-09-05T11:59:30Z" }, now, 60_000),
    ).toBe(false);
  });

  it("rejects stale cleanup evidence and counts export failures", async () => {
    const database = createDbMock();
    database.queueSelect([]); // open requests
    database.queueSelect([{ status: "open" }, { status: "resolved" }]); // operator tasks
    database.queueSelect([{ id: "failure-1" }]); // export failures
    database.queueSelect([]); // notification failures
    const monitor = createPrivacyOperationsMonitor({
      database: database.db as never,
      now: () => now,
      cleanupHealthy: { healthy: true, checkedAt: "2020-01-01T00:00:00Z" },
      notificationHealthy: { healthy: true, checkedAt: now.toISOString() },
      intervalMs: 60_000,
    });
    await expect(monitor.runOnce()).resolves.toMatchObject({
      exportFailures: 1,
      sourceTasksByStatus: { open: 1, resolved: 1 },
    });
    expect(monitor.health()).toMatchObject({
      cleanupHealthy: false,
      notificationHealthy: true,
    });
  });
});
