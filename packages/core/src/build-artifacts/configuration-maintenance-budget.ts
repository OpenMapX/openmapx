/** Prospective encoding arithmetic only. These local maximum-width data
 * expressions never become a signed witness, authority handle or publication. */
import { dirname, join } from "node:path";
import { canonicalJson } from "../ops/canonical-json";
import { protectedConfigurationServiceIdSchema } from "../ops/configuration-handoff-records";
import { configurationMaintenancePrepareSchema } from "../ops/configuration-maintenance";
import type { PreparedConfigurationRecord } from "../ops/configuration-preparation-records";
import type { OpsOperation } from "../ops/contract";
import { parseControlRootOperationKey } from "../ops/control-root-key";
import { executionFingerprint, type RetainedParentExecution } from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";
import { renderServiceSnippet } from "../services/compose-renderer";
import type { renderConfiguration } from "../services/configuration-generation";
import {
  CONFIGURATION_GENERATIONS,
  GENERATED_COMPOSE_FILE,
  STACK_PROJECT,
} from "../services/deployment";
import { parseReleaseManifest, renderReleaseCompose } from "../services/release-manifest";
import { releaseStatePaths } from "../services/release-state";
import { assertProspectiveConfigurationSettlementPacketBudget } from "./configuration-fence-settlement-budget";
import type { ConfigurationMaintenanceOwnerRecord } from "./configuration-maintenance-owner-records";
import {
  buildFixedConfigurationMaintenancePlan,
  type FixedConfigurationMaintenancePlan,
} from "./fixed-configuration-maintenance";

const hash = "f".repeat(64),
  uuid = "ffffffff-ffff-4fff-bfff-ffffffffffff",
  at = Number.MAX_SAFE_INTEGER;
const bytes = (value: unknown) => Buffer.byteLength(canonicalJson(value));
export function assertProspectiveConfigurationMaintenanceBudget(input: {
  installationId: string;
  plan: FixedConfigurationMaintenancePlan;
  originalContainers: ConfigurationMaintenanceOwnerRecord["originalContainers"];
  rendered: ReturnType<typeof renderConfiguration>;
  releaseSourceBytes?: number;
}) {
  const { plan, originalContainers, rendered } = input,
    { kind: _kind, ...binding } = plan.operation,
    identity = {
      installationId: input.installationId,
      origin: {
        version: 1,
        rootKey: plan.prepare.operationKey,
        issuer: "ops-agent",
        notAfter: parseControlRootOperationKey(plan.prepare.operationKey).notAfter,
      },
      ownerPrepare: plan.prepare,
      admissionDigest: hash,
      rootCertificateDigest: hash,
      maintenanceId: binding.maintenanceId,
      candidateId: binding.candidateId,
      planDigest: plan.planDigest,
      settlementId: plan.dmSettle.settlementId,
    },
    guard = { ...plan.dmPrepare, fenceId: uuid, sequence: at, state: "recovery_required" },
    receipt = {
      version: 1,
      binding,
      prepare: plan.prepare,
      apiJobId: plan.apiParent.issuer === "api" ? plan.apiParent.apiJobId : uuid,
      parentOperationKey: plan.apiParent.operationKey,
      parentFingerprint: plan.apiParent.fingerprint,
      parentDeadlineAt: plan.apiParent.deadlineAt,
      planDigest: plan.planDigest,
      serviceIds: plan.serviceIds,
      steps: plan.steps,
      preflight: "unavailable",
      sequence: at,
      state: "recovery_required",
      decision: {
        decisionId: uuid,
        decision: "continue",
        checkpointVersion: at,
        checkpointDigest: hash,
      },
      dmFence: guard,
      generation: "not_committed",
      appliedRevisionId: plan.operation.revisionId,
      followUp: "not_started",
    },
    reservations = [
      ...plan.reservations.filter(
        (value) => !["configuration-fence", "configuration-fence-settle"].includes(value.phase),
      ),
      ...(plan.nestedHardlinks ? [plan.nestedHardlinks] : []),
      ...(plan.nestedHandoff ? [plan.nestedHandoff] : []),
    ],
    children = reservations.map((value) => ({
      planIndex: value.ordinal > 31 ? 31 : value.ordinal,
      execution: {
        ...value.execution,
        operationFingerprint: hash,
        fingerprint: hash,
        deadlineAt: at,
      },
      terminalDigest: hash,
      terminalAt: at,
      effectSettlementDigest: hash,
      publication: "not_started",
    })),
    recreates = new Set([
      ...(plan.handoff?.serviceIds ?? []),
      ...plan.steps.flatMap((value) =>
        value.operation.kind === "service.recreate" ||
        value.operation.kind === "service.recreateIsolated"
          ? [value.operation.serviceId]
          : [],
      ),
    ]),
    futureBase = join(
      rendered.context.infraDir!,
      CONFIGURATION_GENERATIONS,
      plan.operation.revisionId,
    ),
    longest = (a: string, b: string) => (bytes(a) > bytes(b) ? a : b),
    futureContainers = originalContainers.map((value) =>
      recreates.has(value.serviceId)
        ? {
            ...value,
            containerId: hash,
            state: "restarting",
            provenance: {
              ...value.provenance,
              composeWorkingDirectory: longest(
                value.provenance.composeWorkingDirectory,
                futureBase,
              ),
              composeConfigFiles: [0, 1].map((index) =>
                longest(
                  value.provenance.composeConfigFiles[index] ?? "",
                  join(futureBase, "docker-compose.generated.yml"),
                ),
              ),
            },
          }
        : value,
    ),
    checks = [
      "generation",
      "owner-containers",
      "dm-guard",
      ...plan.steps.map(() => "frozen-attempts"),
    ].map((check) => ({
      serviceId: null as string | null,
      ordinal: null as number | null,
      check,
      expectedRevisionId: plan.operation.revisionId,
      expectedImageId: null as string | null,
    })),
    details: unknown[] = [
      {
        currentRevisionId: plan.operation.revisionId,
        ...(plan.release
          ? {
              currentRelease: {
                releaseId: plan.release.releaseId,
                digest: plan.release.manifestDigest,
                updateJobId: uuid,
              },
            }
          : {}),
      },
      { containers: futureContainers },
      { guard },
      ...plan.steps.map((step) => ({
        children: children.filter((value) => value.planIndex === step.ordinal),
      })),
    ];
  for (const id of recreates) {
    const service = rendered.resolved.enabled.find((value) => value.manifest.id === id);
    if (!service) throw Error("Prospective maintenance runtime target unavailable");
    const snippet = renderServiceSnippet(service, rendered.context),
      // The fixed release renderer mounts its privacy validation config in API.
      mountCount =
        (snippet.volumes?.length ?? 0) +
        (snippet.secrets?.length ?? 0) +
        (plan.release && id === "app-api" ? 1 : 0);
    for (const check of ["configuration", "image", "mount", "readiness"])
      checks.push({
        serviceId: id,
        ordinal: null,
        check,
        expectedRevisionId: plan.operation.revisionId,
        expectedImageId: `sha256:${hash}`,
      });
    details.push(
      {
        containerId: hash,
        expectedConfigHash: hash,
        actualConfigHash: hash,
        resources: { memoryBytes: Number.MAX_SAFE_INTEGER, nanoCpus: Number.MAX_SAFE_INTEGER },
        expectedEnvironmentDigest: hash,
        actualEnvironmentDigest: hash,
      },
      {
        containerId: hash,
        imageId: `sha256:${hash}`,
        expectedImageId: `sha256:${hash}`,
        ...(plan.release
          ? {
              releaseReference:
                plan.release.serviceImages[id as keyof typeof plan.release.serviceImages],
              releasePlatformManifestDigest: `sha256:${hash}`,
            }
          : {}),
      },
      {
        containerId: hash,
        mounts: Array.from({ length: mountCount }, () => ({
          targetDigest: hash,
          type: "volume",
          sourceDigest: hash,
          nameDigest: hash,
          readOnly: false,
          expectedDigest: hash,
          actualDigest: hash,
        })),
      },
      { containerId: hash, state: "running", running: false, health: "healthy" },
    );
  }
  // UNUSED has no Docker checks, but adds exact candidate/queue descriptor facts.
  // Budget both alternatives, including their independently escaped detail JSON.
  const unusedDetails = [
    { currentRevisionId: binding.expectedCurrentRevisionId },
    { containers: originalContainers },
    {
      candidateId: binding.candidateId,
      revisionId: binding.revisionId,
      recordDigest: hash,
      directories: ["queue", "claimed"].map((name) => ({
        name,
        dev: at,
        ino: at,
        uid: at,
        gid: at,
        mode: 448,
        entries: 1024,
        matchingCandidateEntries: 0,
      })),
    },
    { guard },
    ...plan.steps.map((step) => ({
      phase: step.phase,
      ordinal: step.ordinal,
      operationKey: step.operationKey,
      binding: null,
      publication: "unissued",
    })),
  ];
  if ([...details, ...unusedDetails].some((value) => bytes(value) > 16384))
    throw Error("Prospective private maintenance observation capacity exceeded");
  const inspectionWidth = (observations: unknown[]) =>
      bytes({
        payload: {
          version: 2,
          identity,
          inspectionId: uuid,
          ownerSequence: at,
          ownerSourceDigest: hash,
          requiredChecks: checks,
          observations: observations.map((detail, checkIndex) => ({
            checkIndex,
            passed: true,
            detail: canonicalJson(detail),
          })),
          runtime: {
            verificationId: uuid,
            mode: "contained",
            requiredCheckSetDigest: hash,
            checkedAt: at,
          },
        },
        signature: "",
      }) + 86,
    inspectionBytes = Math.max(inspectionWidth(details), inspectionWidth(unusedDetails)),
    // The complete final contains both full private children and their compact
    // shared projection; all other final/guard/decision fields have fixed widths.
    finalBytes =
      8192 +
      bytes(children) +
      bytes(
        children.map(({ execution: _execution, ...value }) => ({
          ...value,
          executionDigest: hash,
        })),
      ),
    apiParentBytes = bytes(plan.apiParent) + 64,
    assertionBytes = 4096,
    stepBytes = plan.steps.reduce((sum, step) => {
      const resultBytes =
        step.phase === "configuration-commit"
          ? bytes({
              outcome: "committed",
              revisionId: binding.revisionId,
              enabledServiceIds: plan.serviceIds,
              followUp: "complete",
              cleanupFailed: false,
            })
          : 512;
      // Exact fixed fields: execution+API parent/assertion, grant, canonical
      // status/result/digests/time and durable API receipt delivery.
      return sum + bytes(step.operation) + 2048 + apiParentBytes + assertionBytes + resultBytes;
    }, 0),
    ownerBaseBytes =
      bytes({ plan, originalContainers, receipt, identity }) +
      2048 +
      (plan.steps.some(
        (step) =>
          (step.operation.kind === "service.recreate" ||
            step.operation.kind === "service.recreateIsolated") &&
          step.operation.serviceId === "data-manager",
      )
        ? 8192
        : 0),
    ownerBytes = ownerBaseBytes + inspectionBytes + finalBytes + 2 * 8192 + stepBytes + 8192,
    noGuardOwnerBytes = ownerBaseBytes + 32768,
    receiptBytes = bytes(receipt),
    phaseBytes =
      (plan.reservations.length + (plan.nestedHardlinks ? 1 : 0) + (plan.nestedHandoff ? 1 : 0)) *
      8192;
  const releaseWorkerBytes = plan.release
    ? bytes({
        images: plan.release.downloads.images.map((image) => ({
          image: image.image,
          reference: image.reference,
          phase: "verified",
          imageId: `sha256:${hash}`,
        })),
        overlay: Buffer.from(
          renderReleaseCompose(
            parseReleaseManifest(plan.release.canonicalManifest, plan.release.imagePrefix),
            rendered.context.infraDir!,
          ),
        ).toString("base64"),
        state: Buffer.from(
          JSON.stringify({
            releaseId: plan.release.releaseId,
            digest: plan.release.manifestDigest,
            updateJobId: uuid,
          }),
        ).toString("base64"),
      }) + 24576
    : 0;
  if (
    inspectionBytes > 65536 ||
    releaseWorkerBytes > 65536 ||
    Math.max(ownerBytes, noGuardOwnerBytes) > 131072 ||
    receiptBytes > 65536 ||
    phaseBytes > 131072 ||
    (plan.release &&
      (input.releaseSourceBytes === undefined ||
        !Number.isSafeInteger(input.releaseSourceBytes) ||
        input.releaseSourceBytes < 4 ||
        bytes(plan.release) + input.releaseSourceBytes + 24576 > 65536))
  )
    throw Error("Prospective maintenance owner/inspection/receipt/phase capacity exceeded");
  return Object.freeze({
    ownerBytes: Math.max(ownerBytes, noGuardOwnerBytes),
    inspectionBytes,
    receiptBytes,
    phaseBytes,
  });
}

/** Pre-effect arithmetic for the SAME sealed candidate, not an admission or a
 * proposed execution. Maximum-width future IDs/image/parent data stay local;
 * no signature, nominal token, filesystem record or permission is produced. */
export function assertProspectiveConfigurationMaintenancePreludeBudget(input: {
  installationId: string;
  record: PreparedConfigurationRecord;
  sourceAuthorityRevision: string;
  infraDir: string;
  currentServiceIds: readonly string[];
  originalContainers: ConfigurationMaintenanceOwnerRecord["originalContainers"];
  rendered: ReturnType<typeof renderConfiguration>;
  release?: FixedConfigurationMaintenancePlan["release"];
  releaseSourceBytes?: number;
  coordinatorImage?: Omit<
    NonNullable<FixedConfigurationMaintenancePlan["coordinatorImage"]>,
    "imageId"
  >;
}): void {
  const { record, rendered } = input;
  if (!record.maintenanceId || !record.prepareOperationKey) return;
  const apply = record.operation as Parameters<
    typeof buildFixedConfigurationMaintenancePlan
  >[0]["apply"];
  const platform = record.privatePlatformIntent;
  if (
    !!platform?.release !== !!input.release ||
    (platform?.release &&
      input.release &&
      (platform.release.releaseId !== input.release.releaseId ||
        platform.release.manifestDigest !== input.release.manifestDigest))
  )
    throw Error("Original checked release preflight required");
  const protectedIds = platform?.release
    ? record.affectedServiceIds
    : platform
      ? record.affectedServiceIds.filter(
          (id) => protectedConfigurationServiceIdSchema.safeParse(id).success,
        )
      : [];
  const recreateServiceIds = platform?.release
    ? []
    : platform
      ? record.affectedServiceIds.filter(
          (id) => !protectedConfigurationServiceIdSchema.safeParse(id).success,
        )
      : record.apiFollowUp === "service-apply" ||
          record.privateCoordinatorLifecycle ||
          record.privateIntegrationReload?.stagedMigration
        ? record.affectedServiceIds
        : [];
  const handoff =
    platform && protectedIds.length
      ? {
          handoffId: platform.handoffId,
          previewFingerprint: platform.previewFingerprint,
          serviceIds: protectedIds,
          expectedImageIdentities: Object.fromEntries(
            protectedIds.map((id) => [id, `sha256:${hash}`]),
          ),
          mode: platform.release
            ? { kind: "release" as const, ...platform.release }
            : { kind: "configuration" as const },
        }
      : undefined;
  const operation = configurationMaintenancePrepareSchema.parse({
    kind: "configurationMaintenance.prepare",
    maintenanceId: record.maintenanceId,
    candidateId: record.candidateId,
    applyOperationKey: record.operationKey,
    applyOperationFingerprint: opsOperationFingerprint(apply as OpsOperation),
    expectedCurrentRevisionId: apply.expectedCurrentRevisionId,
    revisionId: apply.revisionId,
    expectedSourceRevision: record.expectedSourceRevision,
    coordinatorMode: apply.coordinatorMode,
    followUp: platform
      ? "platform-apply"
      : recreateServiceIds.length
        ? "service-apply"
        : "render-only",
  });
  const parent: RetainedParentExecution = {
    issuer: "api",
    operationKey: record.parentOperationKey,
    fingerprint: record.parentFingerprint,
    deadlineAt: record.parentDeadlineAt,
    apiJobId: record.apiJobId,
    apiOwnerVersion: at,
    attemptId: uuid,
    assertionDigest: hash,
  };
  const deadlineAt = Math.min(
      parseControlRootOperationKey(record.prepareOperationKey).notAfter,
      parent.deadlineAt,
    ),
    operationFingerprint = opsOperationFingerprint(operation);
  const prepare = {
    executor: "ops-agent" as const,
    principal: "api" as const,
    executionId: `job1_${"f".repeat(64)}`,
    operationKey: record.prepareOperationKey,
    operationFingerprint,
    deadlineAt,
    fingerprint: executionFingerprint({
      kind: operation.kind,
      operationFingerprint,
      deadlineAt,
      parent,
    }),
  };
  const serviceIds = [
    ...new Set([
      ...input.currentServiceIds,
      ...rendered.resolved.enabled.map((service) => service.manifest.id),
      ...record.affectedServiceIds,
      "data-manager",
    ]),
  ].sort();
  const plan = buildFixedConfigurationMaintenancePlan({
    installationId: input.installationId,
    prepare,
    operation,
    apiParent: parent,
    apply,
    candidateRecordDigest: hash,
    sourceAuthorityRevision: input.sourceAuthorityRevision,
    previewDigest: hash,
    hardlinkPlan: { plan: rendered.rendered.hardlinkPlan, prune: true },
    serviceIds,
    recreateServiceIds,
    ...(handoff ? { handoff } : {}),
    ...(input.release ? { release: input.release } : {}),
    ...(input.coordinatorImage
      ? { coordinatorImage: { ...input.coordinatorImage, imageId: `sha256:${hash}` } }
      : {}),
  });
  const currentCompose = join(
      input.infraDir,
      CONFIGURATION_GENERATIONS,
      apply.expectedCurrentRevisionId ?? apply.revisionId,
      GENERATED_COMPOSE_FILE,
    ),
    release = releaseStatePaths(input.infraDir).overlay;
  const longest = (a: string, b: string) => (bytes(a) > bytes(b) ? a : b);
  const observed = new Map(input.originalContainers.map((value) => [value.serviceId, value]));
  // Any selected service may become an owned current-generation container in
  // the pre-root gap. Reserve its full fixed provenance width before the helper
  // or pull; actual admission independently rechecks reality and the cap.
  const containers = [...new Set([...observed.keys(), ...serviceIds])].sort().map((serviceId) => {
    const actual = observed.get(serviceId);
    return {
      serviceId,
      containerId: hash,
      state: "restarting" as const,
      provenance: {
        project: STACK_PROJECT,
        composeWorkingDirectory: longest(
          actual?.provenance.composeWorkingDirectory ?? "",
          dirname(currentCompose),
        ),
        composeConfigFiles: [
          longest(actual?.provenance.composeConfigFiles[0] ?? "", currentCompose),
          longest(actual?.provenance.composeConfigFiles[1] ?? "", release),
        ],
        imageId: `sha256:${hash}`,
      },
    };
  });
  assertProspectiveConfigurationMaintenanceBudget({
    ...(input.release ? { releaseSourceBytes: input.releaseSourceBytes } : {}),
    installationId: input.installationId,
    plan,
    originalContainers: containers,
    rendered,
  });
  assertProspectiveConfigurationSettlementPacketBudget(plan, input.installationId);
}
