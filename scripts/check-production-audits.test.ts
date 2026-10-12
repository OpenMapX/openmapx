import { describe, expect, it } from "vitest";
import {
  checkProductionAuditResults,
  type ProductionAuditPolicy,
} from "./check-production-audits.js";

const NOW = new Date("2026-10-12T12:00:00Z");

function policy(
  overrides: Partial<ProductionAuditPolicy["allowances"][number]> = {},
): ProductionAuditPolicy {
  return {
    schemaVersion: 1,
    allowances: [
      {
        advisoryId: "GHSA-aaaa-bbbb-cccc",
        packageName: "example-package",
        severity: "high",
        workspace: "root",
        versions: ["1.2.3"],
        expiresOn: "2026-11-10",
        reason: "No patched release is published.",
        ...overrides,
      },
    ],
  };
}

function report(
  overrides: Record<string, unknown> = {},
  findingOverrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    advisories: {
      "1234": {
        github_advisory_id: "GHSA-aaaa-bbbb-cccc",
        module_name: "example-package",
        severity: "high",
        vulnerable_versions: "<=1.2.3",
        patched_versions: null,
        patched_versions_unpublished: true,
        findings: [
          {
            version: "1.2.3",
            paths: ["secret/internal/dependency/path"],
            ...findingOverrides,
          },
        ],
        ...overrides,
      },
    },
  });
}

function results(rootStdout: string, rootStatus = 1) {
  return {
    root: { status: rootStatus, stdout: rootStdout },
    docs: { status: 0, stdout: JSON.stringify({ advisories: {} }) },
  } as const;
}

describe("production dependency audit policy", () => {
  it("accepts an exact, unpatched allowance before its expiry", () => {
    const outcome = checkProductionAuditResults(results(report()), policy(), NOW);

    expect(outcome.errors).toEqual([]);
    expect(outcome.notices).toEqual([
      "[root] acknowledged high advisory GHSA-aaaa-bbbb-cccc for example-package@1.2.3 until 2026-11-10",
    ]);
  });

  it.each([
    ["unlisted advisory", policy({ advisoryId: "GHSA-dddd-eeee-ffff" }), NOW],
    ["different installed version", policy({ versions: ["1.2.2"] }), NOW],
    ["different workspace", policy({ workspace: "docs" }), NOW],
  ])("blocks a high-severity finding with an %s", (_label, auditPolicy, now) => {
    const outcome = checkProductionAuditResults(results(report()), auditPolicy, now);

    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toContain(
      "[root] blocking high advisory GHSA-aaaa-bbbb-cccc for example-package@1.2.3",
    );
  });

  it("explains when an otherwise matching allowance has expired", () => {
    const outcome = checkProductionAuditResults(
      results(report()),
      policy(),
      new Date("2026-11-11T00:00:00Z"),
    );

    expect(outcome.errors).toEqual([
      "[root] allowance for GHSA-aaaa-bbbb-cccc and example-package expired on 2026-11-10; re-audit before renewing it",
    ]);
  });

  it("rejects an expired allowance after its advisory disappears", () => {
    const outcome = checkProductionAuditResults(
      results(JSON.stringify({ advisories: {} }), 0),
      policy(),
      new Date("2026-11-11T00:00:00Z"),
    );

    expect(outcome.errors).toEqual([
      "[root] allowance for GHSA-aaaa-bbbb-cccc and example-package expired on 2026-11-10; re-audit before renewing it",
    ]);
  });

  it("blocks an allowed advisory as soon as a patch is published", () => {
    const outcome = checkProductionAuditResults(
      results(
        report({
          patched_versions: ">=1.2.4",
          patched_versions_unpublished: false,
        }),
      ),
      policy(),
      NOW,
    );

    expect(outcome.errors).toEqual([
      "[root] GHSA-aaaa-bbbb-cccc for example-package now has a published patch; remove the allowance and upgrade",
    ]);
  });

  it("blocks an advisory whose severity escalates beyond the allowance", () => {
    const outcome = checkProductionAuditResults(
      results(report({ severity: "critical" })),
      policy(),
      NOW,
    );

    expect(outcome.errors).toEqual([
      "[root] blocking critical advisory GHSA-aaaa-bbbb-cccc for example-package@1.2.3",
    ]);
  });

  it("reports low and moderate advisories without blocking", () => {
    const low = JSON.parse(report({ severity: "low" })) as {
      advisories: Record<string, unknown>;
    };
    const moderate = JSON.parse(
      report({
        github_advisory_id: "GHSA-dddd-eeee-ffff",
        module_name: "another-package",
        severity: "moderate",
      }),
    ) as { advisories: Record<string, unknown> };
    const stdout = JSON.stringify({
      advisories: {
        first: low.advisories["1234"],
        second: moderate.advisories["1234"],
      },
    });

    const outcome = checkProductionAuditResults(results(stdout), policy(), NOW);

    expect(outcome.errors).toEqual([]);
    expect(outcome.warnings).toEqual([
      "[root] observed low advisory GHSA-aaaa-bbbb-cccc for example-package@1.2.3 (non-blocking)",
      "[root] observed moderate advisory GHSA-dddd-eeee-ffff for another-package@1.2.3 (non-blocking)",
    ]);
  });

  it.each([
    ["command failure", results("", 2)],
    ["invalid JSON", results("not-json", 1)],
    ["malformed report", results(JSON.stringify({ advisories: [] }), 1)],
  ])("fails closed on %s without echoing raw audit output", (_label, auditResults) => {
    const outcome = checkProductionAuditResults(auditResults, policy(), NOW);

    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toMatch(
      /audit command failed|invalid audit JSON|malformed audit report/,
    );
    expect(outcome.errors.join("\n")).not.toContain("not-json");
  });

  it("never exposes dependency paths in diagnostics", () => {
    const outcome = checkProductionAuditResults(results(report()), policy(), NOW);
    const diagnostics = [...outcome.errors, ...outcome.notices, ...outcome.warnings].join("\n");

    expect(diagnostics).not.toContain("secret/internal/dependency/path");
  });

  it("fails closed when the allowance policy is malformed", () => {
    const invalidPolicy = policy({ expiresOn: "tomorrow" });

    const outcome = checkProductionAuditResults(results(report()), invalidPolicy, NOW);

    expect(outcome.errors).toEqual(["invalid production audit policy"]);
  });

  it.each([
    ["dependency paths", { paths: ["example-package>transitive-package"] }],
    ["a lockfile hash", { lockfileSha256: "deadbeef" }],
  ])("rejects an allowance containing %s", (_label, extraField) => {
    const basePolicy = policy();
    const invalidPolicy = {
      ...basePolicy,
      allowances: [{ ...basePolicy.allowances[0], ...extraField }],
    };

    const outcome = checkProductionAuditResults(results(report()), invalidPolicy, NOW);

    expect(outcome.errors).toEqual(["invalid production audit policy"]);
  });
});
