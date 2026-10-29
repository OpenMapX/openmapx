import { expect, it } from "vitest";
import { OPS_OPERATION_KINDS, parseOpsRequest } from "./contract";

it("admits only the finite API-owned standalone inspection/install/settlement operations", () => {
  for (const kind of ["integration.inspectInstall", "integration.install", "integration.settle"])
    expect(OPS_OPERATION_KINDS).toContain(kind);
  const operation = {
    kind: "integration.inspectInstall",
    ownerId: "admin",
    source: {
      kind: "uploaded-artifact",
      stageId: "91a78b3e-208b-4ba4-9ddf-870fbdf1da22",
      expectedSha256: "a".repeat(64),
    },
  };
  const request = {
    version: 1,
    requestId: "ops1_abcdefghijklmnop",
    operationKey: "opk1_abcdefghijklmnop",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    operation,
  };
  expect(() => parseOpsRequest(request, { role: "api" })).not.toThrow();
  expect(() => parseOpsRequest(request, { role: "data-manager" })).toThrow();
});
it("exposes finite legacy inventory/ownership/removal operations", () => {
  for (const kind of [
    "integration.inventory",
    "integration.inspectOwnership",
    "integration.remove",
  ])
    expect(OPS_OPERATION_KINDS).toContain(kind);
});
