import { expect, it } from "vitest";
import { OPS_KIND_POLICIES, opsOperationSchema, parseBoundedOpsResult } from "./contract";

it("admits only the paired approval identity through the durable policy", () => {
  const input = {
    kind: "transitousLock.approve",
    proposalId: "00000000-0000-4000-8000-000000000001",
    validationId: "00000000-0000-4000-8000-000000000002",
    expectedGenerationId: null,
    diffDigest: "a".repeat(64),
    acknowledgeLicenseChanges: false,
  };
  expect(opsOperationSchema.parse(input)).toEqual(input);
  expect(
    opsOperationSchema.safeParse({
      kind: "transitousLock.approve",
      ref: `main@${"a".repeat(40)}`,
      approvedBy: "operator",
    }).success,
  ).toBe(false);
  expect(OPS_KIND_POLICIES["transitousLock.approve"].execution).toBe("async");
  expect(() =>
    parseBoundedOpsResult("transitousLock.approve", {
      ref: `main@${"a".repeat(40)}`,
      lockedAt: new Date().toISOString(),
    }),
  ).toThrow();
});

import { verifyFiniteControlEdge } from "../build-artifacts/target-lease";
import { opsOperationFingerprint } from "./fingerprint";

it.each([
  "proposalId",
  "validationId",
  "expectedGenerationId",
  "diffDigest",
  "acknowledgeLicenseChanges",
] as const)("binds the exact paired approval %s into its original body identity", (field) => {
  const body = {
    kind: "transitousLock.approve" as const,
    proposalId: "00000000-0000-4000-8000-000000000001",
    validationId: "00000000-0000-4000-8000-000000000002",
    expectedGenerationId: null,
    diffDigest: "a".repeat(64),
    acknowledgeLicenseChanges: false,
  };
  const changed = {
    ...body,
    [field]:
      field === "diffDigest" || field === "expectedGenerationId"
        ? "b".repeat(64)
        : field === "acknowledgeLicenseChanges"
          ? true
          : "00000000-0000-4000-8000-000000000003",
  };
  expect(opsOperationFingerprint(changed)).not.toBe(opsOperationFingerprint(body));
  expect(opsOperationSchema.safeParse({ ...body, kind: "transitousLock.inspect" }).success).toBe(
    false,
  );
});
it("allows only catalog activation to reserve the closed paired approval phase", () => {
  expect(() =>
    verifyFiniteControlEdge("data-manager", "transit-sync", "paired-pin-commit", "ops-agent"),
  ).toThrow();
  expect(() =>
    verifyFiniteControlEdge(
      "data-manager",
      "transit-maintenance",
      "paired-pin-commit",
      "ops-agent",
    ),
  ).toThrow();
  expect(() =>
    verifyFiniteControlEdge("data-manager", "catalog.activate", "paired-pin-commit", "ops-agent"),
  ).not.toThrow();
});
