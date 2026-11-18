/** One root-fixed CLI Update. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { type OpsOperation, opsOperationSchema } from "../ops/contract";
import { type ExecutionRef, executionRefSchema } from "../ops/execution-ref";
import { canonicalJson, opsOperationFingerprint } from "../ops/fingerprint";
import { currentConfigurationGeneration } from "../services/configuration-generation";
import { controlDigest } from "./control-records";
import { executionAuthorityState, type VerifiedExecutionAuthority } from "./execution-record";
import {
  type ControlChildReservation,
  controlChildOperationKey,
  controlChildReservationSchema,
} from "./lease-store";
import { readPrivateRecord, writePrivateRecord } from "./private-records";

const domain = "openmapx-fixed-service-lifecycle-v1";
const schema = z.strictObject({
  version: z.literal(1),
  parent: executionRefSchema,
  operation: opsOperationSchema,
  rootReservation: controlChildReservationSchema,
  delegationId: z.uuid(),
  finalRevisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
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
  if (!["service.start", "service.update"].includes(s.kind))
    throw Error("Original lifecycle authority required");
  return serviceLifecycleFinalRevisionId(s.origin.rootKey);
}
export function planFixedServiceUpdate(options: {
  infraDir: string;
  parent: ExecutionRef;
  operation: Extract<OpsOperation, { kind: "service.update" }>;
  serviceIds: readonly string[];
}): FixedServiceLifecyclePlan {
  const operation = opsOperationSchema.parse(options.operation),
    finalRevisionId = serviceLifecycleFinalRevisionId(options.parent.operationKey);
  // An update planned against a generation that is no longer current is refused at admission.
  if (
    currentConfigurationGeneration(options.infraDir) !==
    options.operation.expectedConfigurationRevisionId
  )
    throw Error("Lifecycle configuration revision conflict");
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
  return schema.parse({
    version: 1,
    parent: options.parent,
    operation,
    rootReservation,
    delegationId: address(options.parent.operationKey, "challenge"),
    finalRevisionId,
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
    plan,
    true,
  );
}
export function readFixedServiceLifecyclePlan(
  authority: VerifiedExecutionAuthority,
): FixedServiceLifecyclePlan {
  const s = executionAuthorityState(authority),
    plan = schema.parse(
      readPrivateRecord(
        s.installation,
        "observations",
        `service-lifecycle-${s.execution.operationKey}.json`,
        128 * 1024,
      ),
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
