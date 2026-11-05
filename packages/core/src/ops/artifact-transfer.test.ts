import { expect, it } from "vitest";
import { OPS_OPERATION_KINDS } from "./contract";

it("installs only the finite API stage operations, including owner-scoped listing", () => {
  for (const action of ["create", "list", "inspect", "delete", "claim", "inspectClaim", "settle"])
    expect(OPS_OPERATION_KINDS).toContain(`artifactTransfer.${action}`);
});
it("uses the shared outcome discriminator for durable claim settlement", async () => {
  const { stageClaimSettlementSchema } = await import("./artifact-transfer");
  expect(
    stageClaimSettlementSchema.safeParse({ outcome: "unknown", receiptId: "retained" }).success,
  ).toBe(true);
  expect(
    stageClaimSettlementSchema.safeParse({ kind: "unknown", receiptId: "retained" }).success,
  ).toBe(false);
});
it("defines bounded prepared preview and import operations without caller paths or stop assertions", async () => {
  const { opsOperationSchema } = await import("./contract");
  const base = { stageId: "00000000-0000-4000-8000-000000000001", ownerId: "admin" };
  expect(
    opsOperationSchema.safeParse({ kind: "artifactTransfer.previewImport", ...base }).success,
  ).toBe(true);
  expect(
    opsOperationSchema.safeParse({
      kind: "artifactTransfer.import",
      ...base,
      expectedSha256: "a".repeat(64),
      previewFingerprint: "b".repeat(64),
      expectedCurrentRevisionId: null,
    }).success,
  ).toBe(true);
  expect(
    opsOperationSchema.safeParse({
      kind: "artifactTransfer.import",
      ...base,
      expectedSha256: "a".repeat(64),
      previewFingerprint: "b".repeat(64),
      expectedCurrentRevisionId: null,
      consumersStopped: true,
    }).success,
  ).toBe(false);
});

it("exports only named prepared targets under an exact artifact fingerprint", async () => {
  const { opsOperationSchema, OPS_KIND_POLICIES } = await import("./contract");
  const valid = {
    kind: "artifactTransfer.export",
    serviceId: "osrm",
    ownerId: "admin",
    expectedArtifactFingerprint: "a".repeat(64),
  };
  expect(opsOperationSchema.safeParse(valid).success).toBe(true);
  expect(opsOperationSchema.safeParse({ ...valid, serviceId: "redis" }).success).toBe(false);
  expect(opsOperationSchema.safeParse({ ...valid, path: "/arbitrary" }).success).toBe(false);
  expect(OPS_KIND_POLICIES["artifactTransfer.export"]).toMatchObject({
    role: "api",
    execution: "async",
    timeoutMs: 72 * 3600_000,
  });
});
