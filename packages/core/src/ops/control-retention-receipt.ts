/** Server-capable receipt digests and the existing fixed API token proof. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json";
import { type OpsJobStatus, parseBoundedOpsResult, parseOpsJobStatus } from "./contract";

export function controlTerminalReceiptDigest(input: OpsJobStatus): string {
  const s = parseOpsJobStatus(input);
  if (!["succeeded", "failed", "timed_out"].includes(s.state))
    throw Error("A terminal receipt is required");
  const result = s.result === undefined ? null : parseBoundedOpsResult(s.kind, s.result);
  const fields = {
    version: 2,
    operationId: s.operationId,
    operationKey: s.operationKey,
    kind: s.kind,
    admittedAt: s.admittedAt,
    deadlineAt: s.deadlineAt,
    fingerprint: s.fingerprint,
    state: s.state,
    terminationRequestedAt: s.terminationRequestedAt ?? null,
    errorClass: s.errorClass ?? null,
    result,
    failureResult: s.failureResult ?? null,
  };
  if (Buffer.byteLength(canonicalJson(fields)) > 128 * 1024)
    throw Error("Terminal receipt exceeds retention capacity");
  return createHash("sha256")
    .update("openmapx-control-terminal-receipt-v1\0")
    .update(canonicalJson(fields))
    .digest("hex");
}
export const apiRetentionProofSchema = z
  .strictObject({
    version: z.literal(1),
    apiJobId: z.uuid(),
    originalApiOwnerVersion: z.number().int().positive().safe(),
    attemptId: z.uuid(),
    checkpointOwnerVersion: z.number().int().positive().safe(),
    terminalCopyId: z.uuid(),
    operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    terminalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine(
    (v) => v.checkpointOwnerVersion >= v.originalApiOwnerVersion,
    "Receipt owner version predates its original attempt",
  );
export type ApiRetentionProof = z.infer<typeof apiRetentionProofSchema>;
export function signApiRetentionProof(token: string, input: ApiRetentionProof): string {
  const payload = Buffer.from(canonicalJson(apiRetentionProofSchema.parse(input))).toString(
    "base64url",
  );
  return `${payload}.${createHmac("sha256", token).update("openmapx-api-retention-ack-v1\0").update(payload).digest("base64url")}`;
}
export function verifyApiRetentionProof(token: string, proof: string): ApiRetentionProof {
  if (proof.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(proof))
    throw Error("Invalid API retention proof");
  const [payload, signature] = proof.split(".") as [string, string];
  const expected = createHmac("sha256", token)
      .update("openmapx-api-retention-ack-v1\0")
      .update(payload)
      .digest(),
    supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied))
    throw Error("Invalid API retention proof");
  const fields = apiRetentionProofSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(payload, "base64url"))),
  );
  if (Buffer.from(canonicalJson(fields)).toString("base64url") !== payload)
    throw Error("Noncanonical API retention proof");
  return fields;
}

/** Observation only: this never authorizes forward work or changes the failed
 * canonical. A newer API must not mistake an older agent's 200 for recovery. */
const maintenanceRecoveryProofSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("configuration-maintenance-contained"),
  operationId: z.string().regex(/^job1_[A-Za-z0-9_-]{16,64}$/),
  operationKey: apiRetentionProofSchema.shape.operationKey,
  fingerprint: apiRetentionProofSchema.shape.fingerprint,
  terminalDigest: apiRetentionProofSchema.shape.terminalDigest,
  maintenanceId: z.uuid(),
  candidateId: z.uuid(),
  closureDigest: apiRetentionProofSchema.shape.terminalDigest,
  receiverEvidenceDigest: apiRetentionProofSchema.shape.terminalDigest,
  releasedAt: z.number().int().positive().safe(),
});
type MaintenanceRecoveryProof = z.infer<typeof maintenanceRecoveryProofSchema>;
const recoveryDomain = "openmapx-maintenance-recovery-observation-v1\0";
export function signMaintenanceRecoveryProof(
  token: string,
  input: MaintenanceRecoveryProof,
): string {
  const payload = Buffer.from(canonicalJson(maintenanceRecoveryProofSchema.parse(input))).toString(
    "base64url",
  );
  return `${payload}.${createHmac("sha256", token).update(recoveryDomain).update(payload).digest("base64url")}`;
}
export function verifyMaintenanceRecoveryProof(
  token: string,
  proof: string,
): MaintenanceRecoveryProof {
  if (proof.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(proof))
    throw Error("Invalid maintenance recovery observation");
  const [payload, signature] = proof.split(".") as [string, string],
    expected = createHmac("sha256", token).update(recoveryDomain).update(payload).digest(),
    supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied))
    throw Error("Invalid maintenance recovery observation");
  const fields = maintenanceRecoveryProofSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(payload, "base64url"))),
  );
  if (Buffer.from(canonicalJson(fields)).toString("base64url") !== payload)
    throw Error("Noncanonical maintenance recovery observation");
  return fields;
}
