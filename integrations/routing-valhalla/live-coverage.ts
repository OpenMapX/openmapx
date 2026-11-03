import { randomUUID } from "node:crypto";
import type { Route, RoutingTrafficProof } from "@openmapx/core";
import { encodePolyline } from "@openmapx/core";
import { readTrafficProof } from "./traffic-proof.js";

/**
 * What a coverage trace asks the engine for: each traversed edge's length and,
 * where the live write gave it one, its current speed.
 */
export const COVERAGE_TRACE_ATTRIBUTES = ["edge.length", "edge.speeds_non_faded"] as const;

/** Traces per route answer; a longer multi-stop trip keeps unknown coverage. */
export const MAX_COVERAGE_TRACES = 12;

/** A trace whose edges fall this far short of, or beyond, its leg did not walk it. */
const LENGTH_TOLERANCE_RATIO = 0.02;
const LENGTH_TOLERANCE_METRES = 50;

interface TraceEdge {
  length?: unknown;
  speeds_non_faded?: { current_flow?: unknown } | null;
}

/** Subset of a `trace_attributes` answer a coverage trace reads. */
export interface CoverageTraceResponse {
  units?: string;
  edges?: TraceEdge[];
  openmapx_traffic_proof?: unknown;
}

/**
 * Whether every edge of an exact walk of one leg carried a current speed;
 * `null` when the answer cannot say, because it is malformed, empty or does
 * not add up to the leg it was asked to walk.
 *
 * The live writer puts a current speed only on an edge it has a measured speed
 * for (a road-event cap lowers that speed but never stands alone), and a
 * closed edge is never on a route, so a current speed is measured congestion
 * evidence for the edge.
 */
export function legCarriesLiveSpeeds(
  response: CoverageTraceResponse,
  legMetres: number,
): boolean | null {
  const metresPerUnit =
    response.units === undefined || response.units === "kilometers" || response.units === "km"
      ? 1000
      : response.units === "miles" || response.units === "mi"
        ? 1609.344
        : null;
  const edges = response.edges;
  if (metresPerUnit === null || !Array.isArray(edges) || edges.length === 0) return null;
  let metres = 0;
  let allLive = true;
  for (const edge of edges) {
    if (
      !edge ||
      typeof edge.length !== "number" ||
      !Number.isFinite(edge.length) ||
      edge.length < 0
    )
      return null;
    metres += edge.length * metresPerUnit;
    const current = edge.speeds_non_faded?.current_flow;
    if (!(typeof current === "number" && Number.isFinite(current) && current > 0)) allLive = false;
  }
  const tolerance = Math.max(LENGTH_TOLERANCE_METRES, legMetres * LENGTH_TOLERANCE_RATIO);
  if (!Number.isFinite(legMetres) || Math.abs(metres - legMetres) > tolerance) return null;
  return allLive;
}

/** Posts one request body to the engine's `/trace_attributes`. */
export type PostTrace = (body: Record<string, unknown>) => Promise<CoverageTraceResponse>;

/**
 * Coverage evidence for a route the engine answered under `routeProof`: each
 * leg's own shape is walked edge by edge against the same live write, and the
 * route is complete when every edge carried a current speed. Any trace that
 * fails, cannot be proven against that same write, or does not walk its whole
 * leg leaves the coverage unknown (`undefined`), never complete.
 */
export async function traceRouteCoverage(
  route: Route,
  routeProof: RoutingTrafficProof,
  costingOptions: Record<string, unknown>,
  post: PostTrace,
  now: () => number = Date.now,
): Promise<Route["trafficCoverage"]> {
  const legs = (route.legs.length ? route.legs : [route]).filter(
    (leg) => leg.geometry.length >= 2 && leg.distance > 0,
  );
  if (legs.length === 0 || legs.length > MAX_COVERAGE_TRACES) return undefined;
  const costing = routeProof.costing;
  const traced = await Promise.all(
    legs.map(async (leg) => {
      const requestId = randomUUID();
      const startedAt = now();
      try {
        const response = await post({
          encoded_polyline: encodePolyline(leg.geometry, 6),
          shape_match: "edge_walk",
          costing,
          costing_options: { [costing]: costingOptions },
          date_time: { type: 0 },
          filters: { attributes: [...COVERAGE_TRACE_ATTRIBUTES], action: "include" },
          openmapx_request_id: requestId,
        });
        const proof = readTrafficProof(
          response.openmapx_traffic_proof,
          requestId,
          "trace_attributes",
          costing,
          startedAt,
          now(),
        );
        if (
          !proof ||
          proof.writeId !== routeProof.writeId ||
          proof.graphGeneration !== routeProof.graphGeneration ||
          proof.engineBootId !== routeProof.engineBootId
        )
          return null;
        const live = legCarriesLiveSpeeds(response, leg.distance);
        return live === null ? null : { live, validUntil: Date.parse(proof.validUntil) };
      } catch {
        return null;
      }
    }),
  );
  if (traced.some((leg) => leg === null)) return undefined;
  const evaluatedAt = Date.parse(routeProof.evaluatedAt);
  const validUntil = Math.min(
    Date.parse(routeProof.validUntil),
    ...traced.map((leg) => (leg as { validUntil: number }).validUntil),
  );
  if (!(validUntil > now()) || !(evaluatedAt <= now())) return undefined;
  return {
    complete: traced.every((leg) => leg?.live === true),
    evaluatedAt: routeProof.evaluatedAt,
    validUntil: new Date(validUntil).toISOString(),
  };
}
