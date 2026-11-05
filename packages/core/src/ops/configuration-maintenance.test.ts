import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";
import * as maintenance from "./index";

// Portable data vectors only: no fixture is admission or settlement authority.
function receipt(): maintenance.ConfigurationMaintenanceReceipt {
  const prepare = {
    executor: "ops-agent" as const,
    principal: "api" as const,
    executionId: "job1_originalPrepare0001",
    operationKey: "opk1_originalPrepare0001",
    operationFingerprint: "a".repeat(64),
    fingerprint: "b".repeat(64),
    deadlineAt: 200000,
  };
  const binding = {
    maintenanceId: "11111111-1111-4111-8111-111111111111",
    candidateId: "22222222-2222-4222-8222-222222222222",
    applyOperationKey: "opk1_originalApply000001",
    applyOperationFingerprint: "c".repeat(64),
    expectedCurrentRevisionId: `cfg1_${"d".repeat(43)}`,
    revisionId: `cfg1_${"e".repeat(43)}`,
    expectedSourceRevision: "33333333-3333-4333-8333-333333333333",
    coordinatorMode: "ensure-running" as const,
    followUp: "service-apply" as const,
  };
  return {
    version: 1,
    binding,
    prepare,
    apiJobId: "44444444-4444-4444-8444-444444444444",
    parentOperationKey: "opk1_originalApiParent01",
    parentFingerprint: "f".repeat(64),
    parentDeadlineAt: 300000,
    planDigest: "1".repeat(64),
    serviceIds: ["data-manager", "motis"],
    steps: [
      {
        phase: "configuration-commit",
        ordinal: 0,
        operation: {
          kind: "vault.apply",
          serviceId: "data-manager",
          revisionId: binding.revisionId,
          expectedCurrentRevisionId: binding.expectedCurrentRevisionId,
          expectedSourceRevision: binding.expectedSourceRevision,
          coordinatorMode: binding.coordinatorMode,
        },
        operationKey: binding.applyOperationKey,
        operationFingerprint: binding.applyOperationFingerprint,
        serviceIds: ["data-manager", "motis"],
        prerequisites: [],
      },
    ],
    preflight: "current",
    sequence: 2,
    state: "authorized",
    decision: {
      decisionId: "55555555-5555-4555-8555-555555555555",
      decision: "continue",
      checkpointVersion: 1,
      checkpointDigest: "2".repeat(64),
    },
    dmFence: {
      fenceId: "66666666-6666-4666-8666-666666666666",
      maintenanceId: binding.maintenanceId,
      candidateId: binding.candidateId,
      ownerPrepare: prepare,
      planDigest: "1".repeat(64),
      revisionId: binding.revisionId,
      hardlinkPlanDigest: "3".repeat(64),
      sequence: 0,
      state: "prepared",
    },
    generation: "not_started",
    appliedRevisionId: null,
    followUp: "not_started",
  };
}
const checksum = (r: maintenance.ConfigurationMaintenanceReceipt) =>
  maintenance.configurationMaintenanceSettleRequestDigest(r);
describe("outer maintenance request observation checksum", () => {
  it("hashes the exact approved projection/domain independent of JSON object order", () => {
    const r = receipt(),
      { preflight: _preflight, state: _state, ...fields } = r,
      projection = { ...fields, steps: r.steps.map(({ operation: _operation, ...step }) => step) },
      expected = createHash("sha256")
        .update(
          "openmapx-configuration-settle-request-evidence-v1\0" + canonicalJson(projection),
          "utf8",
        )
        .digest("hex");
    expect(checksum(r)).toBe(expected);
    expect(checksum(r)).toMatch(/^[a-f0-9]{64}$/);
    const reverseKeys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverseKeys)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, child]) => [key, reverseKeys(child)]),
            )
          : value;
    expect(checksum(reverseKeys(r) as typeof r)).toBe(expected);
    expect(expected).not.toBe(
      createHash("sha256")
        .update("openmapx-configuration-final-evidence-v2\0" + canonicalJson(projection))
        .digest("hex"),
    );
  });
  it.each([
    (r: maintenance.ConfigurationMaintenanceReceipt) => {
      r.binding.expectedCurrentRevisionId = null;
    },
    (r) => {
      r.binding.candidateId = "77777777-7777-4777-8777-777777777777";
    },
    (r) => {
      r.prepare.deadlineAt++;
    },
    (r) => {
      r.apiJobId = "77777777-7777-4777-8777-777777777777";
    },
    (r) => {
      r.parentOperationKey = "opk1_differentApiParent1";
    },
    (r) => {
      r.parentFingerprint = "4".repeat(64);
    },
    (r) => {
      r.parentDeadlineAt++;
    },
    (r) => {
      r.planDigest = "4".repeat(64);
    },
    (r) => {
      r.serviceIds = ["data-manager", "motis", "valhalla"];
    },
    (r) => {
      r.steps[0]!.operationKey = "opk1_differentStep000001";
    },
    (r) => {
      r.steps[0]!.operationFingerprint = "4".repeat(64);
    },
    (r) => {
      r.steps[0]!.serviceIds = ["data-manager"];
    },
    (r) => {
      r.sequence++;
    },
    (r) => {
      r.decision!.checkpointVersion++;
    },
    (r) => {
      r.decision!.checkpointDigest = "4".repeat(64);
    },
    (r) => {
      r.decision = null;
    },
    (r) => {
      r.dmFence!.sequence++;
    },
    (r) => {
      r.dmFence!.hardlinkPlanDigest = null;
    },
    (r) => {
      r.dmFence = null;
    },
    (r) => {
      r.generation = "committed";
    },
    (r) => {
      r.appliedRevisionId = r.binding.revisionId;
    },
    (r) => {
      r.followUp = "contained";
    },
  ])("changes for each included observation field (%#)", (change) => {
    const r = receipt(),
      original = checksum(r);
    change(r);
    expect(checksum(r)).not.toBe(original);
  });
  it("omits only derived state/preflight and frozen operation bodies", () => {
    const r = receipt(),
      original = checksum(r);
    r.preflight = "unavailable";
    r.state = "recovery_required";
    expect(checksum(r)).toBe(original);
    r.steps[0]!.operation = {
      ...r.steps[0]!.operation,
      serviceId: "motis",
    } as maintenance.ConfigurationMaintenanceEffect;
    expect(checksum(r)).toBe(original);
  });
  it("strictly rejects malformed and oversized receipts before hashing", () => {
    expect(() =>
      checksum({ ...receipt(), callerFlag: true } as maintenance.ConfigurationMaintenanceReceipt),
    ).toThrow();
    const malformed = receipt();
    malformed.steps[0]!.ordinal = 1;
    expect(() => checksum(malformed)).toThrow();
    const oversized = receipt();
    oversized.steps = Array.from({ length: 32 }, (_, ordinal) => ({
      ...oversized.steps[0]!,
      ordinal,
      phase: ordinal === 0 ? "configuration-commit" : "maintenance-recreate",
      serviceIds: [...oversized.serviceIds],
      prerequisites: Array.from({ length: ordinal }, (_, index) => index),
    }));
    oversized.serviceIds = Array.from(
      { length: 256 },
      (_, index) => `service-${String(index).padStart(3, "0")}-${"x".repeat(48)}`,
    );
    for (const step of oversized.steps) step.serviceIds = [...oversized.serviceIds];
    expect(() => checksum(oversized)).toThrow();
  });
});
