import type { RoutingTrafficProof } from "@openmapx/core";

/** The engine endpoints the proxy proves: a route, or a trace of a route's own shape. */
export type ProvenEndpoint = RoutingTrafficProof["endpoint"] | "trace_attributes";

/** A proxy proof for one outbound request to `E`. */
export type EngineTrafficProof<E extends ProvenEndpoint> = Omit<RoutingTrafficProof, "endpoint"> & {
  endpoint: E;
};

/** Accept only a fresh proxy proof bound to this exact outbound request. */
export function readTrafficProof<E extends ProvenEndpoint>(
  value: unknown,
  requestId: string,
  endpoint: E,
  costing: string,
  startedAt: number,
  now = Date.now(),
): EngineTrafficProof<E> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const p = value as Record<string, unknown>;
  if (
    p.schemaVersion !== 1 ||
    p.requestId !== requestId ||
    p.endpoint !== endpoint ||
    p.costing !== costing ||
    (costing !== "auto" && costing !== "motorcycle")
  )
    return undefined;
  for (const key of ["writeId", "graphGeneration", "engineBootId", "validUntil", "evaluatedAt"]) {
    if (typeof p[key] !== "string" || !(p[key] as string).trim() || (p[key] as string).length > 256)
      return undefined;
  }
  const evaluatedAt = Date.parse(p.evaluatedAt as string);
  const validUntil = Date.parse(p.validUntil as string);
  if (!(evaluatedAt >= startedAt && evaluatedAt <= now && validUntil > now)) return undefined;
  return {
    schemaVersion: 1,
    requestId,
    endpoint,
    costing,
    writeId: p.writeId as string,
    graphGeneration: p.graphGeneration as string,
    engineBootId: p.engineBootId as string,
    validUntil: p.validUntil as string,
    evaluatedAt: p.evaluatedAt as string,
  };
}
