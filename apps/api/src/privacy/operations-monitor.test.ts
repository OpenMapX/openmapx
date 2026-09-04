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

  it("samples async storage/key probes and rejects stale cleanup evidence", async () => {
    const database = createDbMock();
    const checkedAt = new Date().toISOString();
    const monitor = createPrivacyOperationsMonitor({
      database: database.db as never,
      keyReady: async () => true,
      storageHealthy: async () => true,
      backupCapability: true,
      cleanupHealthy: { healthy: true, checkedAt: "2020-01-01T00:00:00Z" },
      notificationHealthy: { healthy: true, checkedAt },
      intervalMs: 60_000,
      keyRing: { activeVersion: 5, availableVersions: [2, 5] },
    });
    await monitor.runOnce();
    expect(monitor.health()).toMatchObject({
      monitorHealthy: true,
      keyReady: true,
      storageHealthy: true,
      backupCapability: true,
      cleanupHealthy: false,
      notificationHealthy: true,
      keyRing: { activeVersion: 5, availableVersions: [2, 5] },
    });
  });

  it("reports attachment and source-snapshot cleanup backlogs", async () => {
    const database = createDbMock();
    database.queueSelect([]); // open requests
    database.queueSelect([]); // source tasks
    database.queueSelect([]); // generation failures
    database.queueSelect([{ createdAt: now, revokedAt: now }]); // artifacts
    database.queueSelect([{ id: "source-snapshot-1" }, { id: "source-snapshot-2" }]);
    database.queueSelect([{ id: "attachment-1" }]);
    database.queueSelect([]); // backup review
    database.queueSelect([]); // notification failures
    const monitor = createPrivacyOperationsMonitor({
      database: database.db as never,
      now: () => now,
      keyReady: true,
      storageHealthy: true,
      backupCapability: true,
      cleanupHealthy: true,
      notificationHealthy: true,
      intervalMs: 60_000,
    });

    await expect(monitor.runOnce()).resolves.toMatchObject({
      artifactCleanupBacklog: 1,
      attachmentCleanupBacklog: 1,
      sourceSnapshotCleanupBacklog: 2,
    });
    expect(monitor.health().cleanupHealthy).toBe(false);
  });
});
