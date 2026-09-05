import { describe, expect, it } from "vitest";
import { buildBackupInventory, deriveBackupReviewDecision } from "./backup-review.js";

const manifest = {
  formatVersion: 2 as const,
  createdAt: "2026-08-01T00:00:00.000Z",
  openmapxVersion: "1.0.0",
  services: [
    {
      id: "postgis",
      volumes: [
        {
          name: "db",
          mode: "pg_dump" as const,
          sizeBytes: 42,
          sha256: "a".repeat(64),
        },
      ],
    },
  ],
};

describe("privacy backup review inventory", () => {
  it("builds only a current digest-verified inventory", () => {
    const inventory = buildBackupInventory({
      backupId: "nightly-20260801",
      manifest,
      manifestDigest: "b".repeat(64),
      retentionDays: 30,
      now: new Date("2026-08-02T00:00:00.000Z"),
    });

    expect(inventory).toMatchObject({ formatVersion: 2, verified: true });
    expect(inventory.volumes[0]?.sha256).toBe("a".repeat(64));
  });

  it("rejects omitted, legacy, unknown, or digestless manifest formats", () => {
    const build = (candidate: unknown) =>
      buildBackupInventory({
        backupId: "nightly-20260801",
        manifest: candidate as typeof manifest,
        manifestDigest: "b".repeat(64),
        retentionDays: 30,
      });

    for (const candidate of [
      { ...manifest, formatVersion: undefined },
      { ...manifest, formatVersion: 1 },
      { ...manifest, formatVersion: 3 },
      {
        ...manifest,
        services: [
          {
            ...manifest.services[0],
            volumes: [{ ...manifest.services[0]?.volumes[0], sha256: undefined }],
          },
        ],
      },
    ]) {
      expect(() => build(candidate)).toThrow(/format|digest/i);
    }
  });

  it("uses the current corrupt-or-unverified reason for an unverified inventory", () => {
    const inventory = buildBackupInventory({
      backupId: "nightly-20260801",
      manifest,
      manifestDigest: "b".repeat(64),
      retentionDays: 30,
      now: new Date("2026-08-02T00:00:00.000Z"),
    });

    expect(
      deriveBackupReviewDecision(
        { ...inventory, verified: false },
        { cutoffAt: new Date("2026-08-02T00:00:00.000Z") },
      ),
    ).toEqual({ decision: "unavailable", reasonCode: "corrupt_or_unverified" });
  });
});
