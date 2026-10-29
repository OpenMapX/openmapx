import { expect, it } from "vitest";
import {
  createControlRootOperationKey,
  executionFingerprint,
  opsOperationFingerprint,
} from "../ops";
import { controlChildOperationKey } from "./control-authority";
import {
  assertFixedConfigurationMaintenancePlan,
  buildFixedConfigurationMaintenancePlan,
} from "./fixed-configuration-maintenance";

// Pure plan-data qualification only. These inputs confer no authority and are
// not the real producer/decision/DM positive required by the task.
function input(): Parameters<typeof buildFixedConfigurationMaintenancePlan>[0] {
  const deadlineAt = Date.now() + 60000,
    root = createControlRootOperationKey({ notAfter: deadlineAt, nonce: Buffer.alloc(16, 9) });
  const parent = {
    issuer: "api" as const,
    apiJobId: "11111111-1111-4111-8111-111111111111",
    apiOwnerVersion: 1,
    operationKey: "opk1_originalApiParent0001",
    fingerprint: "a".repeat(64),
    deadlineAt,
    attemptId: "22222222-2222-4222-8222-222222222222",
    assertionDigest: "b".repeat(64),
  };
  const apply = {
    kind: "vault.apply" as const,
    serviceId: "data-manager",
    maintenanceId: "33333333-3333-4333-8333-333333333333",
    candidateId: "44444444-4444-4444-8444-444444444444",
    revisionId: `cfg1_${"a".repeat(43)}`,
    expectedCurrentRevisionId: `cfg1_${"b".repeat(43)}`,
    expectedSourceRevision: "55555555-5555-4555-8555-555555555555",
    coordinatorMode: "ensure-running" as const,
  };
  const operation = {
    kind: "configurationMaintenance.prepare" as const,
    maintenanceId: apply.maintenanceId,
    candidateId: apply.candidateId,
    applyOperationKey: controlChildOperationKey(root, "configuration-commit", 0),
    applyOperationFingerprint: opsOperationFingerprint(apply),
    revisionId: apply.revisionId,
    expectedCurrentRevisionId: apply.expectedCurrentRevisionId,
    expectedSourceRevision: apply.expectedSourceRevision,
    coordinatorMode: apply.coordinatorMode,
    followUp: "service-apply" as const,
  };
  const operationFingerprint = opsOperationFingerprint(operation);
  const prepare = {
    executor: "ops-agent" as const,
    principal: "api" as const,
    executionId: "job1_originalPrepare0001",
    operationKey: root,
    deadlineAt,
    operationFingerprint,
    fingerprint: executionFingerprint({
      kind: operation.kind,
      operationFingerprint,
      deadlineAt,
      parent,
    }),
  };
  return {
    installationId: "66666666-6666-4666-8666-666666666666",
    prepare,
    operation,
    apiParent: parent,
    apply,
    candidateRecordDigest: "c".repeat(64),
    sourceAuthorityRevision: "registry-v1",
    previewDigest: "d".repeat(64),
    serviceIds: ["data-manager", "motis"],
    recreateServiceIds: ["data-manager"],
    hardlinkPlan: {
      prune: true,
      plan: [
        {
          source: "data/source-osm",
          target: "data/motis/osm",
          consumerService: "motis",
          dataType: "osm-pbf",
        },
      ],
    },
  };
}
it("freezes generation, real middle-owner intent and recreation with one immutable fixed-reference settlement", () => {
  const source = input(),
    plan = buildFixedConfigurationMaintenancePlan(source);
  expect(plan.steps.map((value) => [value.ordinal, value.phase, value.prerequisites])).toEqual([
    [0, "configuration-commit", []],
    [1, "maintenance-hardlinks", [0]],
    [2, "maintenance-recreate", [1]],
  ]);
  expect(plan.steps[0]!.operation).toEqual(source.apply);
  expect(plan.steps[0]!.operationKey).toBe(source.operation.applyOperationKey);
  expect(plan.reservations.map((value) => value.ordinal)).toEqual([0, 1, 2, 3, 4]);
  expect(plan.reservations.map((value) => value.kind)).not.toContain("service.start");
  expect(plan.nestedHardlinks).toMatchObject({
    kind: "generation-hardlinks",
    phase: "hardlinks",
    ordinal: 0,
    recipient: "data-manager",
  });
  expect(plan.dmPrepare.planDigest).toBe(plan.planDigest);
  expect(plan.dmPrepare.hardlinkPlanDigest).not.toBe(plan.planDigest);
  expect(Object.keys(plan.dmSettle).sort()).toEqual([
    "candidateId",
    "maintenanceId",
    "planDigest",
    "settlementId",
    "version",
  ]);
  const original = JSON.stringify(plan.dmSettle);
  expect(Reflect.set(plan.dmSettle, "outcome", "applied")).toBe(false);
  expect(JSON.stringify(plan.dmSettle)).toBe(original);
  expect(() => assertFixedConfigurationMaintenancePlan(plan, source.installationId)).not.toThrow();
  const changed = structuredClone(plan);
  changed.steps[1]!.prerequisites = [];
  expect(() => assertFixedConfigurationMaintenancePlan(changed, source.installationId)).toThrow();
});
it.each(["body", "source", "parent", "foreign-target", "protected-target", "capacity"])(
  "refuses %s before admitting any plan authority",
  (reason) => {
    const source = input();
    if (reason === "body") source.apply.revisionId = `cfg1_${"e".repeat(43)}`;
    if (reason === "source")
      source.operation.expectedSourceRevision = "77777777-7777-4777-8777-777777777777";
    if (reason === "parent") source.prepare.deadlineAt++;
    if (reason === "foreign-target") source.recreateServiceIds = ["foreign"];
    if (reason === "protected-target") {
      source.serviceIds = ["app-api", ...source.serviceIds];
      source.recreateServiceIds = ["app-api"];
    }
    if (reason === "capacity") {
      source.serviceIds = Array.from({ length: 31 }, (_, i) => `svc-${String(i).padStart(2, "0")}`);
      source.recreateServiceIds = [...source.serviceIds];
    }
    expect(() => buildFixedConfigurationMaintenancePlan(source)).toThrow();
  },
);

it("retains the frozen coordinator image in the cross-role graph used to reconstruct nonempty hardlinks", async () => {
  const { configurationMaintenanceForwardGraphSchema } = await import(
    "./configuration-maintenance-forward-records"
  );
  const source = input();
  const coordinatorImage = {
    action: "apply" as const,
    noDeps: false,
    imageReference: "example/data-manager:1",
    imageId: `sha256:${"e".repeat(64)}`,
    releaseSelectionDigest: "f".repeat(64),
    pullSubmissionDigest: null,
  };
  const plan = buildFixedConfigurationMaintenancePlan({ ...source, coordinatorImage });
  const { kind: _kind, ...binding } = plan.operation;
  const graph = configurationMaintenanceForwardGraphSchema.parse({
    version: 1,
    binding,
    prepare: plan.prepare,
    apiJobId: plan.apiParent.apiJobId,
    parentOperationKey: plan.apiParent.operationKey,
    parentFingerprint: plan.apiParent.fingerprint,
    parentDeadlineAt: plan.apiParent.deadlineAt,
    planDigest: plan.planDigest,
    serviceIds: plan.serviceIds,
    steps: plan.steps,
    coordinatorImage,
  });
  expect(graph.coordinatorImage).toEqual(coordinatorImage);
  const rebuilt = buildFixedConfigurationMaintenancePlan({
    ...source,
    coordinatorImage: graph.coordinatorImage,
  });
  expect(rebuilt.planDigest).toBe(plan.planDigest);
  expect(rebuilt.steps).toEqual(plan.steps);
});
