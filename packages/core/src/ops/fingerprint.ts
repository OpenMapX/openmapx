import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";
import { type OpsOperation, opsOperationSchema } from "./contract";

export { canonicalJson } from "./canonical-json";

export function opsOperationFingerprint(operation: OpsOperation): string {
  const normalized = opsOperationSchema.parse(operation);
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

/** Evidence of a named applied projection; no configuration values cross the observation boundary. */
export function configurationProjectionFingerprint(values: Record<string, unknown>): string {
  return createHash("sha256")
    .update("openmapx-integration-projection\0")
    .update(canonicalJson(values))
    .digest("hex");
}
