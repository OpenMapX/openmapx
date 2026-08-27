import { createHash } from "node:crypto";
import { type OpsOperation, opsOperationSchema } from "./contract";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function opsOperationFingerprint(operation: OpsOperation): string {
  const normalized = opsOperationSchema.parse(operation);
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}
