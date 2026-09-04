import { describe, expect, it, vi } from "vitest";
import { collectOpenMapxRegistration } from "./openmapx-collectors.js";
import { captureRedisSubjectControl, receiptSnapshotExpiresAt } from "./receipt-snapshot.js";

describe("receipt source snapshots", () => {
  it("captures only safe metadata for the exact offline quota key", async () => {
    const principal = "a".repeat(64);
    const redis = {
      type: vi.fn().mockResolvedValue("zset"),
      pttl: vi.fn().mockResolvedValue(90_000),
      zcard: vi.fn().mockResolvedValue(2),
      get: vi.fn(() => {
        throw new Error("raw Redis values must not be read");
      }),
      scan: vi.fn(() => {
        throw new Error("Redis namespaces must not be scanned");
      }),
    };

    const result = await captureRedisSubjectControl(
      redis,
      principal,
      new Date("2026-09-05T00:00:00Z"),
    );

    expect(redis.type).toHaveBeenCalledWith(`offline-package:prepare:${principal}`);
    expect(redis.pttl).toHaveBeenCalledWith(`offline-package:prepare:${principal}`);
    expect(redis.zcard).toHaveBeenCalledWith(`offline-package:prepare:${principal}`);
    expect(result).toEqual({
      namespace: "offline-package:prepare",
      controlKind: "rolling-quota",
      state: "present",
      entryCount: 2,
      expiresAt: "2026-09-05T00:01:30.000Z",
    });
    expect(JSON.stringify(result)).not.toContain(principal);
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.scan).not.toHaveBeenCalled();
  });

  it("reports an absent exact key without inventing a global Redis hold", async () => {
    const redis = {
      type: vi.fn().mockResolvedValue("none"),
      pttl: vi.fn(),
      zcard: vi.fn(),
    };

    await expect(
      captureRedisSubjectControl(redis, "b".repeat(64), new Date("2026-09-05T00:00:00Z")),
    ).resolves.toBeNull();
    expect(redis.pttl).not.toHaveBeenCalled();
    expect(redis.zcard).not.toHaveBeenCalled();
  });

  it("bounds receipt material through the maximum statutory extension plus artifact window", () => {
    expect(
      receiptSnapshotExpiresAt(new Date("2026-01-31T12:00:00Z"), "UTC", 168).toISOString(),
    ).toBe("2026-04-07T12:00:00.000Z");
  });

  it("uses a receipt-preserved registration stream instead of querying the expired live source", async () => {
    const preserved = {
      id: "receipt-session",
      data: { sessionDigest: "safe-digest", expiresAt: "2026-09-05T00:10:00.000Z" },
      portable: false,
      policyCodes: ["session-token-redacted"],
    };
    const part = await collectOpenMapxRegistration("auth-sessions", {
      userId: "subject",
      cutoffAt: new Date("2026-09-05T00:00:00Z"),
      database: {
        select: () => {
          throw new Error("the expired live session must not be queried");
        },
      } as never,
      receiptSnapshotOverrides: new Map([
        [
          "auth-sessions",
          (async function* () {
            yield preserved;
          })(),
        ],
      ]),
    });

    expect(part.records).toEqual([preserved]);
  });
});
