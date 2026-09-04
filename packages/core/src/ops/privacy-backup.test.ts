import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bindPrivacyBackupCapability,
  createPrivacyBackupCapability,
  PRIVACY_BACKUP_CAPABILITY_TTL_MS,
  privacyBackupSubjectExportRequestSchema,
  privacyBackupSubjectLocatorDigest,
  verifyPrivacyBackupCapability,
} from "./privacy-backup";

const key = randomBytes(32);
const request = {
  requestId: randomUUID(),
  taskId: randomUUID(),
  backupId: "backup-2026-09-04",
  manifestDigest: "a".repeat(64),
  cutoff: "2026-09-04T10:00:00.000Z",
  collectorContract: "openmapx-subject-export-v1" as const,
  subjectLocator: { kind: "user_id" as const, value: "user-1" },
  subjectLocatorDigest: privacyBackupSubjectLocatorDigest({ kind: "user_id", value: "user-1" }),
};

describe("privacy backup capability contract", () => {
  it("round-trips and binds a five-minute capability", () => {
    const now = new Date("2026-09-04T10:00:00.000Z");
    const value = createPrivacyBackupCapability(request, key, now);
    const payload = verifyPrivacyBackupCapability(value, key, new Date(now.getTime() + 1_000));
    expect(payload.requestId).toBe(request.requestId);
    expect(bindPrivacyBackupCapability(payload, request)).toBe(true);
    expect(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)).toBe(
      PRIVACY_BACKUP_CAPABILITY_TTL_MS,
    );
  });

  it("rejects tampering, expiry, and a mismatched request", () => {
    const now = new Date("2026-09-04T10:00:00.000Z");
    const value = createPrivacyBackupCapability(request, key, now);
    expect(() => verifyPrivacyBackupCapability(`${value}x`, key, now)).toThrow();
    expect(() =>
      verifyPrivacyBackupCapability(
        value,
        key,
        new Date(now.getTime() + PRIVACY_BACKUP_CAPABILITY_TTL_MS),
      ),
    ).toThrow();
    const payload = verifyPrivacyBackupCapability(value, key, now);
    expect(bindPrivacyBackupCapability(payload, { ...request, backupId: "other" })).toBe(false);
    expect(
      bindPrivacyBackupCapability(payload, {
        ...request,
        subjectLocator: { kind: "user_id", value: "user-2" },
      }),
    ).toBe(false);
  });

  it("rejects unknown request fields", () => {
    expect(() =>
      privacyBackupSubjectExportRequestSchema.parse({
        version: 1,
        ...request,
        capability: "pbcap1.invalid.invalid",
        subjectLocator: { kind: "user_id", value: "user-1" },
        unexpected: true,
      }),
    ).toThrow();
  });
});
