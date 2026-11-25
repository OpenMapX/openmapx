/** Server-capable terminal receipt digests. */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";
import { type OpsJobStatus, parseBoundedOpsResult, parseOpsJobStatus } from "./contract";

export function controlTerminalReceiptDigest(input: OpsJobStatus): string {
  const s = parseOpsJobStatus(input);
  if (!["succeeded", "failed", "timed_out"].includes(s.state))
    throw Error("A terminal receipt is required");
  const result = s.result === undefined ? null : parseBoundedOpsResult(s.kind, s.result);
  const fields = {
    version: 1,
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
    throw Error("Terminal receipt exceeds its size limit");
  return createHash("sha256")
    .update("openmapx-control-terminal-receipt-v1\0")
    .update(canonicalJson(fields))
    .digest("hex");
}
