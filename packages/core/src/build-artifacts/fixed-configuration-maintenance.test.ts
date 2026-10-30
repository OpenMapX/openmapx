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

it("freezes a checked release snapshot in the original helper graph without a pre-pull recreate", async () => {
  const source = input(),
    { serviceId: _serviceId, ...ordinary } = source.apply as Extract<
      typeof source.apply,
      { kind: "vault.apply" }
    >,
    apply = { ...ordinary, kind: "stack.render" as const },
    operation = {
      ...source.operation,
      followUp: "platform-apply" as const,
      applyOperationFingerprint: opsOperationFingerprint(apply),
    },
    operationFingerprint = opsOperationFingerprint(operation),
    prepare = {
      ...source.prepare,
      operationFingerprint,
      fingerprint: executionFingerprint({
        kind: operation.kind,
        operationFingerprint,
        deadlineAt: source.prepare.deadlineAt,
        parent: source.apiParent,
      }),
    };
  const manifest = parseReleaseManifest(
    JSON.stringify({
      schemaVersion: 1,
      release: "checked-release-01",
      images: Object.fromEntries(
        RELEASE_IMAGE_NAMES.map((name) => [
          name,
          `ghcr.io/openmapx/${name}@sha256:${"3".repeat(64)}`,
        ]),
      ),
      privacyReleaseValidation: {
        version: 1,
        sourceBuildFingerprint: "a".repeat(64),
        validatedAt: "2026-10-30T00:00:00Z",
        checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
      },
    }),
  );
  const canonicalManifest = canonicalReleaseManifest(manifest),
    manifestDigest = createHash("sha256").update(canonicalManifest).digest("hex"),
    release = {
      version: 1 as const,
      releaseId: manifest.release,
      manifestDigest,
      canonicalManifest,
      imagePrefix: "ghcr.io/openmapx",
      serviceImages: {
        "app-api": manifest.images.api,
        "app-web": manifest.images.web,
        "data-manager": manifest.images["data-manager"],
        "ops-agent": manifest.images["ops-agent"],
        "transitous-runner": manifest.images["transitous-runner"],
      },
      downloads: {
        version: 1 as const,
        platform: "linux/amd64" as const,
        declaredBytes: 7 * 512,
        images: RELEASE_IMAGE_NAMES.map((image) => ({
          image,
          reference: manifest.images[image],
          platformManifestDigest: `sha256:${"4".repeat(64)}`,
          configDigest: `sha256:${"5".repeat(64)}`,
          declaredBytes: 512,
        })),
      },
    },
    handoff = {
      handoffId: "77777777-7777-4777-8777-777777777777",
      previewFingerprint: "e".repeat(64),
      serviceIds: ["app-api", "ops-agent"],
      expectedImageIdentities: {
        "app-api": `sha256:${"1".repeat(64)}`,
        "ops-agent": `sha256:${"2".repeat(64)}`,
      },
      mode: { kind: "release" as const, releaseId: manifest.release, manifestDigest },
    },
    args = {
      ...source,
      operation,
      prepare,
      apply,
      serviceIds: ["app-api", "data-manager", "motis", "ops-agent"],
      recreateServiceIds: [],
      handoff,
      release,
    };
  const plan = buildFixedConfigurationMaintenancePlan(args);
  expect(plan).toHaveProperty("release", release);
  expect(plan.steps.map((step) => step.phase)).toEqual([
    "configuration-commit",
    "maintenance-hardlinks",
    "maintenance-handoff",
  ]);
  expect(() => assertFixedConfigurationMaintenancePlan(plan, source.installationId)).not.toThrow();
  const { configurationHandoffIntentRecordSchema } = await import(
    "./configuration-handoff-records"
  );
  const intent = {
    version: 1,
    installationId: source.installationId,
    origin: {
      version: 1,
      rootKey: prepare.operationKey,
      issuer: "ops-agent",
      notAfter: prepare.deadlineAt,
    },
    ownerPrepare: prepare,
    preparer: prepare,
    helper: {
      ...prepare,
      executor: "host-cli",
      executionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
    operation: plan.steps.at(-1)!.operation,
    admittedAt: Date.now(),
    requestedDeadlineAt: prepare.deadlineAt,
    helperPublicKey: "a".repeat(43),
    sourceDigest: "b".repeat(64),
    environmentNames: [],
    preparerAdmissionDigest: "c".repeat(64),
    ownerCertificateDigest: "d".repeat(64),
    leaseId: "88888888-8888-4888-8888-888888888888",
    delegationId: "99999999-9999-4999-8999-999999999999",
    assertion: "original-fixed-assertion",
    helperContainerName: `openmapx-configuration-handoff-${handoff.handoffId}`,
    preparedAt: Date.now(),
    release,
    previousReleaseOverlay: null,
    previousReleaseState: null,
  };
  expect(configurationHandoffIntentRecordSchema.parse(intent).release).toEqual(release);
  expect(
    configurationHandoffIntentRecordSchema.safeParse({ ...intent, release: undefined }).success,
  ).toBe(false);
  expect(
    configurationHandoffIntentRecordSchema.safeParse({
      ...intent,
      release: { ...release, manifestDigest: "f".repeat(64) },
    }).success,
  ).toBe(false);
  expect(
    configurationHandoffIntentRecordSchema.safeParse({
      ...intent,
      operation: { ...intent.operation, mode: { kind: "configuration" } },
    }).success,
  ).toBe(false);
  const { configurationMaintenanceForwardGraphSchema } = await import(
    "./configuration-maintenance-forward-records"
  );
  const { kind: _kind, ...binding } = operation;
  if (source.apiParent.issuer !== "api") throw Error("API graph required");
  const graph = configurationMaintenanceForwardGraphSchema.parse({
    version: 1,
    binding,
    prepare,
    apiJobId: source.apiParent.apiJobId,
    parentOperationKey: source.apiParent.operationKey,
    parentFingerprint: source.apiParent.fingerprint,
    parentDeadlineAt: source.apiParent.deadlineAt,
    planDigest: plan.planDigest,
    serviceIds: plan.serviceIds,
    steps: plan.steps,
    handoff: plan.handoff,
    release: plan.release,
  });
  expect(graph.release).toEqual(release);
  const { release: _release, ...missing } = args;
  expect(() => buildFixedConfigurationMaintenancePlan(missing)).toThrow();
  expect(() =>
    buildFixedConfigurationMaintenancePlan({ ...args, recreateServiceIds: ["data-manager"] }),
  ).toThrow();
  expect(() =>
    buildFixedConfigurationMaintenancePlan({
      ...args,
      handoff: { ...handoff, mode: { kind: "configuration" } },
    }),
  ).toThrow();
});

it("freezes protected handoff after the original generation and ordinary children", async () => {
  const source = input();
  const { serviceId: _serviceId, ...ordinary } = source.apply as Extract<
    typeof source.apply,
    { kind: "vault.apply" }
  >;
  const apply = { ...ordinary, kind: "stack.render" as const };
  const operation = {
    ...source.operation,
    followUp: "platform-apply" as const,
    applyOperationFingerprint: opsOperationFingerprint(apply),
  };
  const operationFingerprint = opsOperationFingerprint(operation);
  const prepare = {
    ...source.prepare,
    operationFingerprint,
    fingerprint: executionFingerprint({
      kind: operation.kind,
      operationFingerprint,
      deadlineAt: source.prepare.deadlineAt,
      parent: source.apiParent,
    }),
  };
  const handoff = {
    handoffId: "77777777-7777-4777-8777-777777777777",
    previewFingerprint: "e".repeat(64),
    serviceIds: ["app-api", "ops-agent"],
    expectedImageIdentities: {
      "app-api": `sha256:${"1".repeat(64)}`,
      "ops-agent": `sha256:${"2".repeat(64)}`,
    },
    mode: { kind: "configuration" as const },
  };
  const args = {
    ...source,
    apply,
    operation,
    prepare,
    serviceIds: ["app-api", "data-manager", "motis", "ops-agent"],
    handoff,
  };
  const plan = buildFixedConfigurationMaintenancePlan(args);
  expect(plan.steps.map((s) => s.phase)).toEqual([
    "configuration-commit",
    "maintenance-hardlinks",
    "maintenance-recreate",
    "maintenance-handoff",
  ]);
  const step = plan.steps.at(-1)!;
  expect(step.operation).toMatchObject({
    kind: "configurationHandoff.prepare",
    handoffId: handoff.handoffId,
    expectedCurrentRevisionId: operation.revisionId,
    maintenanceId: operation.maintenanceId,
    candidateId: operation.candidateId,
    planDigest: plan.planDigest,
    mode: { kind: "configuration" },
  });
  expect(step.prerequisites).toEqual([2]);
  expect(plan.nestedHandoff).toMatchObject({
    phase: "configuration-handoff",
    ordinal: 0,
    kind: "configuration-helper",
    recipient: "configuration-helper",
    serviceIds: handoff.serviceIds,
  });
  const { configurationMaintenanceForwardGraphSchema } = await import(
    "./configuration-maintenance-forward-records"
  );
  const { kind: _kind, ...binding } = operation;
  if (source.apiParent.issuer !== "api") throw Error("API plan fixture required");
  const graph = configurationMaintenanceForwardGraphSchema.parse({
    version: 1,
    binding,
    prepare,
    apiJobId: source.apiParent.apiJobId,
    parentOperationKey: source.apiParent.operationKey,
    parentFingerprint: source.apiParent.fingerprint,
    parentDeadlineAt: source.apiParent.deadlineAt,
    planDigest: plan.planDigest,
    serviceIds: plan.serviceIds,
    steps: plan.steps,
    handoff: plan.handoff,
  });
  expect(graph).toHaveProperty("handoff", handoff);
  expect(plan.nestedHandoff?.execution.operationKey).toBe(
    controlChildOperationKey(step.operationKey, "configuration-handoff", 0),
  );
  expect(() => assertFixedConfigurationMaintenancePlan(plan, source.installationId)).not.toThrow();
  const changed = structuredClone(plan);
  changed.handoff!.expectedImageIdentities["app-api"] = `sha256:${"3".repeat(64)}`;
  expect(() => assertFixedConfigurationMaintenancePlan(changed, source.installationId)).toThrow();
});

import { createHash } from "node:crypto";
import {
  canonicalReleaseManifest,
  parseReleaseManifest,
  RELEASE_IMAGE_NAMES,
} from "../services/release-manifest";
