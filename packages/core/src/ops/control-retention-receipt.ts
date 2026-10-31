/** Server-capable receipt digests and the existing fixed API token proof. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json";
import { type OpsJobStatus, parseObservedOpsResult, parseOpsJobStatus } from "./contract";

export function controlTerminalReceiptDigest(input: OpsJobStatus): string {
  const s = parseOpsJobStatus(input);
  if (s.version !== 2 || !["succeeded", "failed", "timed_out"].includes(s.state))
    throw Error("A version2 terminal receipt is required");
  const result = s.result === undefined ? null : parseObservedOpsResult(s.kind, s.result);
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
