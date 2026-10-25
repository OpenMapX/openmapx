/** Fixed administrative data-command plans and private write-ahead receipts. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { type OpsOperation, opsOperationSchema } from "../ops/contract";
import { type ExecutionRef, executionRefSchema } from "../ops/execution-ref";
import { canonicalJson, opsOperationFingerprint } from "../ops/fingerprint";
import {
  type DataChildAttempt,
  type DataExecutionInput,
  dataChildAttemptSchema,
  normalizeDataExecutionInput,
  ordinaryDataExecutionInputSchema,
} from "../services/data-manager/contracts/executions";
import {
  type ControlChildReservation,
  controlChildReservationSchema,
  lookupControlChildPhase,
} from "./child-phase";
import {
  controlChildOperationKey,
  controlDigest,
  executionAuthorityState,
  readPrivateRecord,
  signControl,
  type VerifiedExecutionAuthority,
  verifyControl,
  verifyDataControlTerminalWitness,
  withPrivateEffectWriter,
  writePrivateRecord,
} from "./control-authority";

const fixedDataKinds = [
  "data.downloadOsm",
  "data.downloadFonts",
  "data.convertOverpass",
  "data.overtureSync",
  "data.overtureConflate",
  "data.searchIndexBuild",
  "data.notablePlacesBuild",
];
export function isFixedSingleDataCommand(kind: string): boolean {
  return fixedDataKinds.includes(kind);
}
function uuidFor(key: string, purpose: string) {
  const bytes = createHash("sha256")
    .update(`openmapx-fixed-data-address-v1\0${key}\0${purpose}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const fixedDataBodyFingerprint = (input: DataExecutionInput) =>
  controlDigest(normalizeDataExecutionInput(input));
export function fixedDataCommandInput(
  operation: OpsOperation,
  defaultRegion?: string,
): DataExecutionInput {
  const region = "regionId" in operation ? (operation.regionId ?? defaultRegion) : defaultRegion;
  switch (operation.kind) {
    case "data.downloadOsm":
      return ordinaryDataExecutionInputSchema.parse({ kind: "download-osm", region });
    case "data.downloadFonts":
      return { kind: "download-fonts" };
    case "data.convertOverpass":
      return ordinaryDataExecutionInputSchema.parse({ kind: "convert-overpass", region });
    case "data.overtureSync":
      return ordinaryDataExecutionInputSchema.parse({ kind: "overture-sync", region });
    case "data.overtureConflate":
      return ordinaryDataExecutionInputSchema.parse({
        kind: "overture-conflate",
        region,
        restart: operation.restart,
      });
    case "data.searchIndexBuild":
      return ordinaryDataExecutionInputSchema.parse({ kind: "search-index-build", region });
    case "data.notablePlacesBuild":
      return { kind: "notable-places-build" };
    default:
      throw Error("Only an existing matching single data command is supported");
  }
}
const bundleSchema = z.strictObject({
  version: z.literal(1),
  parent: executionRefSchema,
  operation: opsOperationSchema,
  input: ordinaryDataExecutionInputSchema,
  rootReservation: controlChildReservationSchema,
  cliReservations: z.array(controlChildReservationSchema).length(1),
  delegationId: z.uuid(),
});
export function planFixedSingleDataCommand(
  parent: ExecutionRef,
  operation: OpsOperation,
  serviceIds: readonly string[],
  defaultRegion?: string,
) {
  const input = fixedDataCommandInput(operation, defaultRegion),
    cliId = uuidFor(parent.operationKey, "cli"),
    cliKey = controlChildOperationKey(parent.operationKey, "data-workflow", 0),
    targets = [...serviceIds].sort();
  const rootReservation: ControlChildReservation = {
    version: 1,
    phase: "data-workflow",
    ordinal: 0,
    kind: operation.kind,
    recipient: "fixed-cli",
    serviceIds: targets,
    operationFingerprint: opsOperationFingerprint(operation),
    execution: {
      executor: "host-cli",
      principal: parent.principal,
      executionId: cliId,
      operationKey: cliKey,
    },
  };
  const cliReservations: ControlChildReservation[] = [
    {
      version: 1,
      phase: "data-step",
      ordinal: 0,
      kind: input.kind,
      recipient: "data-manager",
      serviceIds: targets,
      operationFingerprint: fixedDataBodyFingerprint(input),
      execution: {
        executor: "data-manager",
        principal: "host-cli",
        executionId: uuidFor(parent.operationKey, "dm"),
        operationKey: controlChildOperationKey(cliKey, "data-step", 0),
      },
    },
  ];
  return bundleSchema.parse({
    version: 1,
    parent,
    operation,
    input,
    rootReservation,
    cliReservations,
    delegationId: uuidFor(parent.operationKey, "challenge"),
  });
}
export function retainFixedSingleDataPlan(
  authority: VerifiedExecutionAuthority,
  plan: ReturnType<typeof planFixedSingleDataCommand>,
): void {
  const s = executionAuthorityState(authority),
    body = bundleSchema.parse(plan);
  if (
    s.installation.installation.role !== "ops-agent" ||
    s.installation.fixedChildId ||
    controlDigest(body.parent) !== controlDigest(s.execution) ||
    opsOperationFingerprint(body.operation) !== s.execution.operationFingerprint ||
    !s.reservations.some((slot) => canonicalJson(slot) === canonicalJson(body.rootReservation))
  )
    throw Error("Original fixed data admission plan required");
  writePrivateRecord(
    s.installation,
    "observations",
    `data-plan-${s.execution.operationKey}.json`,
    signControl(s.installation.privateKey, "openmapx-fixed-data-plan-v1", body),
    true,
    s.origin,
  );
}
export function readFixedSingleDataPlan(authority: VerifiedExecutionAuthority) {
  const s = executionAuthorityState(authority),
    body = verifyControl(
      s.installation.installation.publicKey,
      "openmapx-fixed-data-plan-v1",
      readPrivateRecord(
        s.installation,
        "observations",
        `data-plan-${s.execution.operationKey}.json`,
        8192,
      ),
      bundleSchema,
    );
  if (
    controlDigest(body.parent) !== controlDigest(s.execution) ||
    opsOperationFingerprint(body.operation) !== s.execution.operationFingerprint ||
    !s.reservations.some((slot) => canonicalJson(slot) === canonicalJson(body.rootReservation))
  )
    throw Error("Retained fixed command plan changed");
  return body;
}
export function readCliDataAttempt(
  authority: VerifiedExecutionAuthority,
  key: string,
): DataChildAttempt | null {
  const s = executionAuthorityState(authority);
  let raw: unknown;
  try {
    raw = readPrivateRecord(s.installation, "observations", `data-attempt-${key}.json`, 8192);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return verifyControl(
    s.installation.installation.publicKey,
    "openmapx-cli-data-attempt-v1",
    raw,
    dataChildAttemptSchema,
  );
}
export function retainCliDataAttempt(
  authority: VerifiedExecutionAuthority,
  value: DataChildAttempt,
): void {
  const s = executionAuthorityState(authority),
    attempt = dataChildAttemptSchema.parse(value),
    slot = s.reservations.find((item) => item.execution.operationKey === attempt.operationKey),
    binding = slot ? lookupControlChildPhase(authority, slot) : null;
  if (
    !slot ||
    !binding ||
    !isFixedSingleDataCommand(s.kind) ||
    slot.phase !== "data-step" ||
    slot.kind !== attempt.input.kind ||
    slot.operationFingerprint !== fixedDataBodyFingerprint(attempt.input) ||
    attempt.operationFingerprint !== slot.operationFingerprint ||
    canonicalJson(attempt.parentExecution) !== canonicalJson(s.execution) ||
    attempt.requestedDeadlineAt !== binding.execution.deadlineAt ||
    (attempt.id && attempt.id !== binding.execution.executionId) ||
    (attempt.fingerprint && attempt.fingerprint !== binding.execution.fingerprint)
  )
    throw Error("Exact retained data command binding required");
  withPrivateEffectWriter(s, () => {
    const prior = readCliDataAttempt(authority, attempt.operationKey);
    if (prior) {
      const { state: _old, id: _id, fingerprint: _fp, deadlineAt: _deadline, ...before } = prior,
        { state: _next, id: _id2, fingerprint: _fp2, deadlineAt: _deadline2, ...after } = attempt;
      if (
        canonicalJson(before) !== canonicalJson(after) ||
        (prior.state !== "prepared" && attempt.state === "prepared") ||
        (prior.id && prior.id !== attempt.id) ||
        (prior.fingerprint && prior.fingerprint !== attempt.fingerprint) ||
        (prior.state === "terminal" && canonicalJson(prior) !== canonicalJson(attempt))
      )
        throw Error("Retained CLI data attempt is immutable");
    }
    writePrivateRecord(
      s.installation,
      "observations",
      `data-attempt-${attempt.operationKey}.json`,
      signControl(s.installation.privateKey, "openmapx-cli-data-attempt-v1", attempt),
      !prior,
      s.origin,
    );
  });
}
export function verifyCliDataTerminal(
  authority: VerifiedExecutionAuthority,
  status: import("../services/data-manager/contracts/executions").DataExecutionStatus,
) {
  const s = executionAuthorityState(authority),
    slot = s.reservations.find((item) => item.execution.operationKey === status.operationKey),
    binding = slot ? lookupControlChildPhase(authority, slot) : null;
  if (
    !binding ||
    binding.execution.executionId !== status.id ||
    binding.execution.fingerprint !== status.fingerprint
  )
    throw Error("Original bound data command required");
  return verifyDataControlTerminalWitness(s.installation.installation, binding.execution, status);
}

export function cliDataReservation(authority: VerifiedExecutionAuthority) {
  const s = executionAuthorityState(authority),
    slots = s.reservations.filter(
      (slot) => slot.recipient === "data-manager" && slot.phase === "data-step",
    );
  if (!isFixedSingleDataCommand(s.kind) || slots.length !== 1)
    throw Error("Matching data command reservation required");
  return {
    ...slots[0]!,
    serviceIds: [...slots[0]!.serviceIds],
    execution: { ...slots[0]!.execution },
  };
}
