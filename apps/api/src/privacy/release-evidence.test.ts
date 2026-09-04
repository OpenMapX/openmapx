import { afterEach, describe, expect, it, vi } from "vitest";
import {
  derivePrivacyReleaseEvidenceVersion,
  privacyCryptoReleaseContract,
  resolvePrivacyReleaseEvidence,
} from "./release-evidence.js";

const evidence = {
  reviewLabel: "release-2026-09",
  sourceBuildFingerprint: "1".repeat(64),
  catalogue: [{ id: "account-profile", version: 1 }],
  collectorContracts: {
    archive: 1,
    managedDawarich: "openmapx-subject-export-v1",
    retainedBackup: 1,
  },
  canonicalPrivacyCopy: {
    de: { title: "Datenauskunft" },
    en: { title: "Data access" },
  },
  crypto: { aadVersion: 1, cipherVersion: 1 },
  roles: { approvalRole: "admin", privacyRole: "privacy_admin", version: 1 },
  retention: { artifactHours: 168, backupDays: 30, caseDays: 1095 },
  deployment: {
    controller: { country: "DE", email: "privacy@example.test", name: "Example" },
    jurisdiction: "DE",
    sources: [{ id: "off-host-mail", strategy: "operator_task" }],
  },
} as const;

describe("privacy release evidence version", () => {
  it("binds the approved crypto implementation contract without deployment key versions", () => {
    expect(privacyCryptoReleaseContract()).toEqual({
      aadVersion: 1,
      artifactCipher: "aes-256-gcm",
      cipherVersion: 1,
      keyDerivation: "hkdf-sha-256",
      keyRingFormatVersion: 1,
      keyRingMaxKeys: 8,
      keyWrappingCipher: "aes-256-gcm",
    });
    expect(privacyCryptoReleaseContract()).not.toHaveProperty("masterKeyVersion");
  });
  it("invalidates approvals when any reviewed implementation or deployment fact changes", () => {
    const current = derivePrivacyReleaseEvidenceVersion(evidence);
    const changed = [
      { ...evidence, sourceBuildFingerprint: "2".repeat(64) },
      { ...evidence, catalogue: [{ id: "account-profile", version: 2 }] },
      {
        ...evidence,
        collectorContracts: { ...evidence.collectorContracts, retainedBackup: 2 },
      },
      {
        ...evidence,
        canonicalPrivacyCopy: {
          ...evidence.canonicalPrivacyCopy,
          en: { title: "Your data access" },
        },
      },
      { ...evidence, crypto: { ...evidence.crypto, aadVersion: 2 } },
      { ...evidence, roles: { ...evidence.roles, version: 2 } },
      { ...evidence, retention: { ...evidence.retention, artifactHours: 72 } },
      {
        ...evidence,
        deployment: { ...evidence.deployment, jurisdiction: "AT" },
      },
    ];
    expect(changed.map(derivePrivacyReleaseEvidenceVersion)).not.toContain(current);
    expect(current).toMatch(/^gdpr-release-v1\.[a-f0-9]{64}$/);
  });

  it("keeps an invalid controller configuration machine-readable and fail-closed", async () => {
    for (const name of [
      "LEGAL_NAME",
      "LEGAL_STREET",
      "LEGAL_POSTAL_CODE",
      "LEGAL_CITY",
      "LEGAL_COUNTRY",
      "LEGAL_DATA_REQUEST_EMAIL",
      "LEGAL_EMAIL",
      "LEGAL_DEPLOYMENT_JURISDICTION",
      "LEGAL_SUPERVISORY_AUTHORITY",
    ])
      vi.stubEnv(name, "");
    const database = {
      select: () => ({ from: async () => [] }),
    } as never;
    const result = await resolvePrivacyReleaseEvidence(database, {
      reviewLabel: "fixture",
      sourceBuildFingerprint: "3".repeat(64),
    });
    expect(result.controllerContactConfigured).toBe(false);
    expect(result.sourceBuildFingerprint).toBe("3".repeat(64));
    expect(result.version).toMatch(/^gdpr-release-v1\.[a-f0-9]{64}$/);
  });

  it("is stable when object keys have different insertion order", () => {
    const reordered = {
      ...evidence,
      deployment: {
        sources: evidence.deployment.sources,
        jurisdiction: evidence.deployment.jurisdiction,
        controller: {
          name: evidence.deployment.controller.name,
          email: evidence.deployment.controller.email,
          country: evidence.deployment.controller.country,
        },
      },
    };
    expect(derivePrivacyReleaseEvidenceVersion(reordered)).toBe(
      derivePrivacyReleaseEvidenceVersion(evidence),
    );
  });
});

afterEach(() => vi.unstubAllEnvs());
