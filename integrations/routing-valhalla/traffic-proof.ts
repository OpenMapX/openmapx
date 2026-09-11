import type { RoutingTrafficProof } from "@openmapx/core";

/** Accept only a fresh proxy proof bound to this exact outbound request. */
export function readTrafficProof(
  value: unknown,
  requestId: string,
  endpoint: RoutingTrafficProof["endpoint"],
  costing: string,
  startedAt: number,
  now = Date.now(),
): RoutingTrafficProof | undefined {
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
