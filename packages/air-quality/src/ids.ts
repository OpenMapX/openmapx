import { createHash } from "node:crypto";

export interface ObservationIdentity {
  sourceId: string;
  originRecordId: string;
  spatialSupportId: string;
  modelRunId: string | null;
  evaluatedAt: string;
}

export interface IndexIdentity {
  observationId: string;
  methodId: string;
  methodRevision: string;
  standardId: string | null;
  standardRevision: string | null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Identity values must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => {
        if (item === undefined) throw new TypeError("Identity values must not be undefined");
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(",")}}`;
  }
  throw new TypeError("Identity values must be JSON-compatible");
}

function opaqueId(namespace: "obs" | "idx", value: object): string {
  const digest = createHash("sha256")
    .update(`openmapx-air-quality-${namespace}-v1\0`)
    .update(canonicalJson(value))
    .digest("base64url");
  return `${namespace}_1_${digest}`;
}

export function observationId(identity: ObservationIdentity): string {
  const evaluatedAt = Date.parse(identity.evaluatedAt);
  if (!Number.isFinite(evaluatedAt))
    throw new TypeError("Observation evaluatedAt must be an instant");
  return opaqueId("obs", { ...identity, evaluatedAt: new Date(evaluatedAt).toISOString() });
}

export function indexId(identity: IndexIdentity): string {
  return opaqueId("idx", identity);
}
