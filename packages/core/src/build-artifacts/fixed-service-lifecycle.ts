/** One root-fixed CLI Update and its optional, root-fixed generation leaf. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { type OpsOperation, opsOperationSchema } from "../ops/contract";
import { type ExecutionRef, executionRefSchema } from "../ops/execution-ref";
import { canonicalJson, opsOperationFingerprint } from "../ops/fingerprint";
import { generationHardlinksPlanSchema } from "../services/data-manager/contracts/executions";
import { type ControlChildReservation, controlChildReservationSchema } from "./child-phase";
import {
  controlChildOperationKey,
  executionAuthorityState,
  readPrivateRecord,
  type VerifiedExecutionAuthority,
  writePrivateRecord,
} from "./control-authority";
import { controlDigest, signControl, verifyControl } from "./control-records";
import { readOwnedGenerationHardlinkPlan } from "./generation-hardlinks-owner";

const domain = "openmapx-fixed-service-lifecycle-v1";
const schema = z.strictObject({
  version: z.literal(1),
  parent: executionRefSchema,
  operation: opsOperationSchema,
  rootReservation: controlChildReservationSchema,
  cliReservations: z.array(controlChildReservationSchema).max(1),
  delegationId: z.uuid(),
  finalRevisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
  plan: generationHardlinksPlanSchema,
});
export type FixedServiceLifecyclePlan = z.infer<typeof schema>;
function address(key: string, purpose: string) {
  const b = createHash("sha256").update(`${domain}\0${key}\0${purpose}`).digest().subarray(0, 16);
  b[6] = (b[6]! & 15) | 64;
  b[8] = (b[8]! & 63) | 128;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function serviceLifecycleFinalRevisionId(rootOperationKey: string): string {
  if (!/^opk1_[A-Za-z0-9_-]{16,64}$/.test(rootOperationKey))
    throw Error("Lifecycle root identity required");
  return `cfg1_${createHash("sha256").update(`${domain}\0final-generation\0${rootOperationKey}`).digest("base64url")}`;
}
export function ownedServiceLifecycleFinalRevisionId(
  authority: VerifiedExecutionAuthority,
): string {
  const s = executionAuthorityState(authority);
  if (!["service.start", "service.update"].includes(s.kind) || !s.origin)
    throw Error("Original lifecycle authority required");
  return serviceLifecycleFinalRevisionId(s.origin.rootKey);
}
export function lifecycleHardlinkReservation(options: {
  parent: Pick<ExecutionRef, "executor" | "principal" | "executionId" | "operationKey">;
  revisionId: string;
  plan: z.infer<typeof generationHardlinksPlanSchema>;
  serviceIds: readonly string[];
}): ControlChildReservation | null {
  if (!options.plan.plan.length) return null;
  const input = {
    kind: "generation-hardlinks",
    revisionId: options.revisionId,
    coordinatorMode: "ensure-running",
    planDigest: controlDigest(options.plan),
  };
  return controlChildReservationSchema.parse({
    version: 1,
    phase: "hardlinks",
    ordinal: 0,
    kind: "generation-hardlinks",
    recipient: "data-manager",
    serviceIds: [...options.serviceIds].sort(),
    operationFingerprint: controlDigest(input),
    execution: {
      executor: "data-manager",
      principal: "host-cli",
      executionId: address(options.parent.operationKey, "hardlinks"),
      operationKey: controlChildOperationKey(options.parent.operationKey, "hardlinks", 0),
    },
  });
}
export function planFixedServiceUpdate(options: {
  infraDir: string;
  parent: ExecutionRef;
  operation: Extract<OpsOperation, { kind: "service.update" }>;
  serviceIds: readonly string[];
}): FixedServiceLifecyclePlan {
  const operation = opsOperationSchema.parse(options.operation),
    finalRevisionId = serviceLifecycleFinalRevisionId(options.parent.operationKey);
  const plan = readOwnedGenerationHardlinkPlan(
    options.infraDir,
    options.operation.expectedConfigurationRevisionId,
  );
  const child = {
    executor: "host-cli" as const,
    principal: "host-cli" as const,
    executionId: address(options.parent.operationKey, "cli"),
    operationKey: controlChildOperationKey(options.parent.operationKey, "lifecycle", 0),
  };
  const rootReservation: ControlChildReservation = {
    version: 1,
    phase: "lifecycle",
    ordinal: 0,
    kind: operation.kind,
    recipient: "fixed-cli",
    serviceIds: [...options.serviceIds].sort(),
    operationFingerprint: opsOperationFingerprint(operation),
    execution: child,
  };
  const leaf = lifecycleHardlinkReservation({
    parent: child,
    revisionId: finalRevisionId,
    plan,
    serviceIds: options.serviceIds,
  });
  return schema.parse({
    version: 1,
    parent: options.parent,
    operation,
    rootReservation,
    cliReservations: leaf ? [leaf] : [],
    delegationId: address(options.parent.operationKey, "challenge"),
    finalRevisionId,
    plan,
  });
}
export function retainFixedServiceLifecyclePlan(
  authority: VerifiedExecutionAuthority,
  value: FixedServiceLifecyclePlan,
): void {
  const s = executionAuthorityState(authority),
    plan = schema.parse(value);
  if (
    s.kind !== "service.update" ||
    s.installation.fixedChildId ||
    s.installation.installation.role !== "ops-agent" ||
    controlDigest(s.execution) !== controlDigest(plan.parent) ||
    opsOperationFingerprint(plan.operation) !== s.execution.operationFingerprint ||
    !s.reservations.some((slot) => canonicalJson(slot) === canonicalJson(plan.rootReservation))
  )
    throw Error("Original lifecycle admission plan required");
  writePrivateRecord(
    s.installation,
    "observations",
    `service-lifecycle-${s.execution.operationKey}.json`,
    signControl(s.installation.privateKey, domain, plan),
    true,
    s.origin,
  );
}
export function readFixedServiceLifecyclePlan(
  authority: VerifiedExecutionAuthority,
): FixedServiceLifecyclePlan {
  const s = executionAuthorityState(authority),
    plan = verifyControl(
      s.installation.installation.publicKey,
      domain,
      readPrivateRecord(
        s.installation,
        "observations",
        `service-lifecycle-${s.execution.operationKey}.json`,
        128 * 1024,
      ),
      schema,
    );
  if (
    s.kind !== "service.update" ||
    controlDigest(s.execution) !== controlDigest(plan.parent) ||
    opsOperationFingerprint(plan.operation) !== s.execution.operationFingerprint ||
    !s.reservations.some((slot) => canonicalJson(slot) === canonicalJson(plan.rootReservation))
  )
    throw Error("Original lifecycle admission plan required");
  return plan;
}
