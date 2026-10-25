import { describe, expect, it } from "vitest";
import { parseIntegrationRecord, repairIntegrationRecordLocators } from "./integration-records";

const sha = "a".repeat(64);
const base = {
  version: 1,
  integrationId: "fixture-integration",
  extensionId: "fixture-extension",
  status: "ok",
  reason: null,
  source: { kind: "artifact", url: "https://example.test/archive.tar.gz", sha256: sha },
  files: [{ path: "manifest.json", sha256: sha }],
  pending: null,
};

describe("integration record artifact locators", () => {
  it.each([
    "https://user@example.test/archive.tar.gz",
    "https://user:password@example.test/archive.tar.gz",
    "https://example.test/archive.tar.gz?token=secret",
    "https://example.test/archive.tar.gz#secret",
  ])("does not trust a secret-bearing artifact locator: %s", (url) => {
    expect(() =>
      parseIntegrationRecord(
        { ...base, source: { kind: "artifact", url, sha256: sha } },
        "fixture-integration",
      ),
    ).toThrow();
  });

  it.each([
    ["current", "prepared"],
    ["previous", "prepared"],
    ["next", "prepared"],
    ["current", "published"],
    ["previous", "published"],
    ["next", "published"],
  ] as const)("repairs an unsafe %s source in a %s transaction", (location, phase) => {
    const unsafe = {
      ...base,
      source: {
        kind: "artifact",
        url: "https://sentinel-user:sentinel-password@example.test/private?token=sentinel-query",
        sha256: sha,
      },
    };
    const safeInstallation = {
      extensionId: base.extensionId,
      status: base.status,
      reason: base.reason,
      source: base.source,
      files: base.files,
    };
    const unsafeInstallation = {
      extensionId: unsafe.extensionId,
      status: unsafe.status,
      reason: unsafe.reason,
      source: unsafe.source,
      files: unsafe.files,
    };
    const raw = {
      ...(location === "current" ? unsafe : base),
      pending: {
        transactionId: `itx1_${"b".repeat(24)}`,
        phase,
        replaced: true,
        previous: location === "previous" ? unsafeInstallation : safeInstallation,
        next: location === "next" ? unsafeInstallation : safeInstallation,
      },
    };

    const repaired = repairIntegrationRecordLocators(raw, "fixture-integration");

    expect(repaired.changed).toBe(true);
    expect(JSON.stringify(repaired.record)).not.toMatch(/sentinel-|\/private/);
    const affected =
      location === "current"
        ? repaired.record
        : location === "previous"
          ? repaired.record.pending?.previous
          : repaired.record.pending?.next;
    expect(affected).toMatchObject({
      extensionId: "fixture-extension",
      status: "needs_reinstall",
      reason: "Its recorded artifact locator is no longer accepted; reinstall it.",
      source: null,
      files: [],
    });
    expect(repaired.record.pending).toMatchObject({
      transactionId: `itx1_${"b".repeat(24)}`,
      phase,
      replaced: true,
    });
  });

  it("canonicalizes a safe legacy artifact locator", () => {
    const repaired = repairIntegrationRecordLocators(
      {
        ...base,
        source: {
          kind: "artifact",
          url: "https://EXAMPLE.test:443/releases/../archive.tar.gz",
          sha256: sha,
        },
      },
      "fixture-integration",
    );
    expect(repaired).toMatchObject({
      changed: true,
      record: { source: { url: "https://example.test/archive.tar.gz" } },
    });
  });

  it("leaves an already-safe record unchanged", () => {
    expect(repairIntegrationRecordLocators(base, "fixture-integration")).toEqual({
      record: base,
      changed: false,
    });
  });
});
