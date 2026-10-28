/** Pure closed maintenance graph construction. Plans are data; only the actual
 * production admission/store may turn one into original owner authority. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type ConfigurationMaintenancePrepare,
  type ConfigurationMaintenanceStep,
  configurationMaintenancePrepareSchema,
  configurationMaintenanceStepSchema,
  protectedConfigurationServiceIdSchema,
} from "../ops/configuration-maintenance";
import { type OpsOperation, opsOperationSchema } from "../ops/contract";
import {
  type ExecutionRef,
  executionFingerprint,
  executionRefSchema,
  type RetainedParentExecution,
  retainedParentExecutionSchema,
} from "../ops/execution-identity";
import { canonicalJson, opsOperationFingerprint } from "../ops/fingerprint";
import { servicePullResultSchema } from "../ops/service-operation-records";
import {
  dataConfigurationFencePrepareSchema,
  dataConfigurationFenceSettleSchema,
} from "../services/data-manager/contracts/configuration-maintenance";
import { generationHardlinksPlanSchema } from "../services/data-manager/contracts/executions";
import { deriveConfigurationFenceSettlementId } from "./configuration-fence-settlement-records";
import {
  type ControlChildReservation,
  controlChildOperationKey,
  controlChildReservationSchema,
} from "./control-child-records";
import { controlDigest } from "./control-records";
import { generationHardlinksReservation } from "./generation-hardlinks-records";

const ids = z
  .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
  .min(1)
  .max(256)
  .refine((values) => values.every((value, i) => i === 0 || values[i - 1]! < value));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const coordinatorImageSchema = z.strictObject({
  action: z.enum(["apply", "update"]),
  noDeps: z.boolean(),
  imageReference: servicePullResultSchema.shape.imageReference,
  imageId: servicePullResultSchema.shape.imageId,
  releaseSelectionDigest: servicePullResultSchema.shape.releaseSelectionDigest,
  pullSubmissionDigest: digest.nullable(),
});
export const fixedConfigurationMaintenancePlanSchema = z.strictObject({
  version: z.literal(1),
  prepare: executionRefSchema,
  operation: configurationMaintenancePrepareSchema,
  apiParent: retainedParentExecutionSchema.refine((value) => value.issuer === "api"),
  candidateRecordDigest: digest,
  sourceAuthorityRevision: z.string().min(1).max(128),
  previewDigest: digest,
  coordinatorImage: coordinatorImageSchema.optional(),
  serviceIds: ids,
  planDigest: digest,
  hardlinkPlan: generationHardlinksPlanSchema,
  steps: z.array(configurationMaintenanceStepSchema).min(1).max(32),
  reservations: z
    .array(z.lazy(() => controlChildReservationSchema))
    .min(3)
    .max(34),
  nestedHardlinks: z.lazy(() => controlChildReservationSchema).nullable(),
  dmPrepare: dataConfigurationFencePrepareSchema,
  dmSettle: dataConfigurationFenceSettleSchema,
});
export type FixedConfigurationMaintenancePlan = z.infer<
  typeof fixedConfigurationMaintenancePlanSchema
>;
type GenerationOperation = Extract<
  OpsOperation,
  {
    kind:
      | "stack.render"
      | "serviceSelection.apply"
      | "serviceConfig.apply"
      | "integrationConfig.apply"
      | "vault.apply";
  }
>;
function address(
  root: string,
  phase: string,
  ordinal: number,
  executor: "ops-agent" | "data-manager",
) {
  const bytes = createHash("sha256")
    .update(`openmapx-fixed-configuration-maintenance-v1\0${root}\0${phase}\0${ordinal}`)
    .digest();
  const executionId =
    executor === "ops-agent"
      ? `job1_${bytes.toString("base64url").slice(0, 32)}`
      : (() => {
          const value = Buffer.from(bytes.subarray(0, 16));
          value[6] = (value[6]! & 15) | 64;
          value[8] = (value[8]! & 63) | 128;
          const h = value.toString("hex");
          return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
        })();
  return {
    executor,
    principal: "api" as const,
    executionId,
    operationKey: controlChildOperationKey(
      root,
      phase as ControlChildReservation["phase"],
      ordinal,
    ),
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function buildFixedConfigurationMaintenancePlan(input: {
  installationId: string;
  prepare: ExecutionRef;
  operation: ConfigurationMaintenancePrepare;
  apiParent: RetainedParentExecution;
  apply: GenerationOperation;
  candidateRecordDigest: string;
  sourceAuthorityRevision: string;
  previewDigest: string;
  hardlinkPlan: z.infer<typeof generationHardlinksPlanSchema>;
  serviceIds: readonly string[];
  recreateServiceIds: readonly string[];
  coordinatorImage?: z.infer<typeof coordinatorImageSchema>;
}): FixedConfigurationMaintenancePlan {
  const prepare = executionRefSchema.parse(input.prepare),
    operation = configurationMaintenancePrepareSchema.parse(input.operation),
    apply = opsOperationSchema.parse(input.apply) as GenerationOperation,
    serviceIds = ids.parse(input.serviceIds),
    hardlinkPlan = generationHardlinksPlanSchema.parse(input.hardlinkPlan),
    parent = retainedParentExecutionSchema.parse(input.apiParent);
  if (
    parent.issuer !== "api" ||
    prepare.executor !== "ops-agent" ||
    prepare.principal !== "api" ||
    prepare.operationFingerprint !== opsOperationFingerprint(operation) ||
    operation.followUp === "platform-apply" ||
    ![
      "stack.render",
      "serviceSelection.apply",
      "serviceConfig.apply",
      "integrationConfig.apply",
      "vault.apply",
    ].includes(apply.kind) ||
    !("revisionId" in apply) ||
    !("expectedCurrentRevisionId" in apply) ||
    !("expectedSourceRevision" in apply) ||
    !("coordinatorMode" in apply) ||
    apply.maintenanceId !== operation.maintenanceId ||
    apply.candidateId !== operation.candidateId ||
    apply.revisionId !== operation.revisionId ||
    apply.expectedCurrentRevisionId !== operation.expectedCurrentRevisionId ||
    apply.expectedSourceRevision !== operation.expectedSourceRevision ||
    apply.coordinatorMode !== operation.coordinatorMode ||
    opsOperationFingerprint(apply) !== operation.applyOperationFingerprint ||
    operation.applyOperationKey !==
      controlChildOperationKey(prepare.operationKey, "configuration-commit", 0) ||
    prepare.deadlineAt > parent.deadlineAt ||
    prepare.fingerprint !==
      executionFingerprint({
        kind: operation.kind,
        operationFingerprint: prepare.operationFingerprint,
        deadlineAt: prepare.deadlineAt,
        parent,
      })
  )
    throw Error("Fixed maintenance candidate binding conflict");
  const recreates = [...new Set(input.recreateServiceIds)].sort();
  if (
    input.coordinatorImage &&
    (canonicalJson(recreates) !== '["data-manager"]' ||
      (input.coordinatorImage.action === "apply" &&
        (input.coordinatorImage.noDeps || input.coordinatorImage.pullSubmissionDigest !== null)) ||
      (input.coordinatorImage.action === "update" &&
        input.coordinatorImage.pullSubmissionDigest === null))
  )
    throw Error("Fixed coordinator image expectation conflict");
  if (
    recreates.length !== input.recreateServiceIds.length ||
    recreates.some(
      (id) =>
        !serviceIds.includes(id) || protectedConfigurationServiceIdSchema.safeParse(id).success,
    ) ||
    (operation.followUp === "render-only" && recreates.length) ||
    (operation.followUp === "service-apply" && !recreates.length)
  )
    throw Error("Fixed maintenance continuation conflict");
  const intents: {
    phase: ConfigurationMaintenanceStep["phase"];
    operation: OpsOperation;
    prerequisites: number[];
  }[] = [{ phase: "configuration-commit", operation: apply, prerequisites: [] }];
  if (hardlinkPlan.plan.length)
    intents.push({
      phase: "maintenance-hardlinks",
      operation: {
        kind: "configuration.hardlinks.apply",
        maintenanceId: operation.maintenanceId,
        candidateId: operation.candidateId,
        revisionId: operation.revisionId,
        coordinatorMode: operation.coordinatorMode,
      },
      prerequisites: [0],
    });
  for (const serviceId of recreates)
    intents.push({
      phase: "maintenance-recreate",
      operation: {
        kind: input.coordinatorImage?.noDeps ? "service.recreateIsolated" : "service.recreate",
        serviceId,
        expectedConfigurationRevisionId: operation.revisionId,
        maintenanceId: operation.maintenanceId,
      },
      prerequisites: [intents.length - 1],
    });
  if (intents.length > 32) throw Error("Fixed maintenance effect capacity exceeded");
  const { kind: _kind, ...binding } = operation;
  const planDigest = createHash("sha256")
    .update("openmapx-configuration-maintenance-plan-v1\0")
    .update(
      canonicalJson({
        version: 1,
        binding,
        serviceIds,
        ...(input.coordinatorImage ? { coordinatorImage: input.coordinatorImage } : {}),
        steps: intents.map((step, ordinal) => ({ ...step, ordinal, serviceIds })),
      }),
    )
    .digest("hex");
  const reservations: ControlChildReservation[] = [];
  const steps = intents.map((intent, ordinal) => {
    const body =
      intent.phase === "configuration-commit"
        ? intent.operation
        : { ...intent.operation, planDigest };
    const execution = address(prepare.operationKey, intent.phase, ordinal, "ops-agent"),
      operationFingerprint = opsOperationFingerprint(body as OpsOperation);
    reservations.push({
      version: 1,
      phase: intent.phase,
      ordinal,
      kind: body.kind,
      recipient: "ops-agent",
      serviceIds,
      execution,
      operationFingerprint,
    });
    return configurationMaintenanceStepSchema.parse({
      phase: intent.phase,
      ordinal,
      operation: body,
      operationKey: execution.operationKey,
      operationFingerprint,
      serviceIds,
      prerequisites: intent.prerequisites,
    });
  });
  const dmPrepare = dataConfigurationFencePrepareSchema.parse({
    maintenanceId: operation.maintenanceId,
    candidateId: operation.candidateId,
    ownerPrepare: prepare,
    planDigest,
    serviceIds,
    revisionId: operation.revisionId,
    hardlinkPlanDigest: hardlinkPlan.plan.length ? controlDigest(hardlinkPlan) : null,
    coordinatorMode: operation.coordinatorMode,
  });
  reservations.push({
    version: 1,
    phase: "configuration-fence",
    ordinal: steps.length,
    kind: "configuration-maintenance.prepare",
    recipient: "data-manager",
    serviceIds,
    execution: address(prepare.operationKey, "configuration-fence", steps.length, "data-manager"),
    operationFingerprint: controlDigest({
      kind: "configuration-maintenance.prepare",
      ...dmPrepare,
    }),
  });
  const dmSettle = dataConfigurationFenceSettleSchema.parse({
    version: 2,
    maintenanceId: operation.maintenanceId,
    candidateId: operation.candidateId,
    planDigest,
    settlementId: deriveConfigurationFenceSettlementId({
      installationId: input.installationId,
      ownerPrepare: prepare,
      maintenanceId: operation.maintenanceId,
      candidateId: operation.candidateId,
      planDigest,
    }),
  });
  reservations.push({
    version: 1,
    phase: "configuration-fence-settle",
    ordinal: steps.length + 1,
    kind: "configuration-maintenance.settle",
    recipient: "data-manager",
    serviceIds,
    execution: address(
      prepare.operationKey,
      "configuration-fence-settle",
      steps.length + 1,
      "data-manager",
    ),
    operationFingerprint: controlDigest({ kind: "configuration-maintenance.settle", ...dmSettle }),
  });
  const middle = reservations.find((value) => value.phase === "maintenance-hardlinks");
  return freeze(
    fixedConfigurationMaintenancePlanSchema.parse({
      version: 1,
      prepare,
      operation,
      apiParent: parent,
      candidateRecordDigest: input.candidateRecordDigest,
      sourceAuthorityRevision: input.sourceAuthorityRevision,
      previewDigest: input.previewDigest,
      ...(input.coordinatorImage ? { coordinatorImage: input.coordinatorImage } : {}),
      serviceIds,
      planDigest,
      hardlinkPlan,
      steps,
      reservations,
      dmPrepare,
      dmSettle,
      nestedHardlinks: middle
        ? generationHardlinksReservation({
            parent: middle.execution,
            revisionId: operation.revisionId,
            coordinatorMode: operation.coordinatorMode,
            plan: hardlinkPlan,
            serviceIds,
          })
        : null,
    }),
  );
}
/** Restore comparisons recompute every derived body/address from the original
 * retained inputs. A schema-valid signed summary is not a frozen graph. */
export function assertFixedConfigurationMaintenancePlan(
  value: FixedConfigurationMaintenancePlan,
  installationId: string,
): void {
  const plan = fixedConfigurationMaintenancePlanSchema.parse(value),
    first = plan.steps[0];
  if (!first || first.phase !== "configuration-commit")
    throw Error("Missing fixed generation step");
  const recreateServiceIds = plan.steps.flatMap((step) =>
    step.operation.kind === "service.recreate" || step.operation.kind === "service.recreateIsolated"
      ? [step.operation.serviceId]
      : [],
  );
  const rebuilt = buildFixedConfigurationMaintenancePlan({
    installationId,
    prepare: plan.prepare,
    operation: plan.operation,
    apiParent: plan.apiParent,
    apply: first.operation as GenerationOperation,
    candidateRecordDigest: plan.candidateRecordDigest,
    sourceAuthorityRevision: plan.sourceAuthorityRevision,
    previewDigest: plan.previewDigest,
    ...(plan.coordinatorImage ? { coordinatorImage: plan.coordinatorImage } : {}),
    hardlinkPlan: plan.hardlinkPlan,
    serviceIds: plan.serviceIds,
    recreateServiceIds,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(plan))
    throw Error("Fixed maintenance graph changed");
}
