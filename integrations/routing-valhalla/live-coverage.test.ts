import type { Route, RoutingTrafficProof } from "@openmapx/core";
import { decodePolyline } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import {
  type CoverageTraceResponse,
  legCarriesLiveSpeeds,
  MAX_COVERAGE_TRACES,
  traceRouteCoverage,
} from "./live-coverage";

const NOW = Date.parse("2026-11-03T17:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const routeProof: RoutingTrafficProof = {
  schemaVersion: 1,
  requestId: "11111111-1111-4111-8111-111111111111",
  writeId: "write-1",
  graphGeneration: "graph-1",
  engineBootId: "boot-1",
  evaluatedAt: at(-1_000),
  validUntil: at(90_000),
  endpoint: "route",
  costing: "auto",
};

const live = (km: number, kph = 54) => ({ length: km, speeds_non_faded: { current_flow: kph } });
const unmeasured = (km: number) => ({ length: km, speeds_non_faded: { no_flow: 99 } });

function leg(
  geometry: [number, number][],
  distance: number,
): { geometry: [number, number][]; distance: number } {
  return { geometry, distance };
}

function route(legs: Array<{ geometry: [number, number][]; distance: number }>): Route {
  return {
    distance: legs.reduce((sum, l) => sum + l.distance, 0),
    duration: 600,
    geometry: legs.flatMap((l) => l.geometry),
    legs: legs.map((l) => ({ ...l, duration: 300, steps: [] })),
    steps: [],
    mode: "driving",
  };
}

// Valhalla shapes carry six decimals, as polyline6 does.
const LEG_A = leg(
  [
    [7.038389, 52.312634],
    [7.022633, 52.311417],
  ],
  1083,
);
const LEG_B = leg(
  [
    [7.022633, 52.311417],
    [7.01, 52.31],
  ],
  900,
);

/** An engine that proves every trace against `write` and answers with `edges`. */
function engine(
  edgesFor: (index: number) => CoverageTraceResponse["edges"],
  proof: Partial<RoutingTrafficProof> = {},
) {
  const bodies: Record<string, unknown>[] = [];
  const post = async (body: Record<string, unknown>): Promise<CoverageTraceResponse> => {
    const index = bodies.push(body) - 1;
    return {
      units: "kilometers",
      edges: edgesFor(index),
      openmapx_traffic_proof: {
        schemaVersion: 1,
        requestId: body.openmapx_request_id,
        writeId: "write-1",
        graphGeneration: "graph-1",
        engineBootId: "boot-1",
        evaluatedAt: at(0),
        validUntil: at(60_000),
        endpoint: "trace_attributes",
        costing: "auto",
        ...proof,
      },
    };
  };
  return { post, bodies };
}

describe("legCarriesLiveSpeeds", () => {
  it("is true only when every edge of the walked leg carried a current speed", () => {
    expect(legCarriesLiveSpeeds({ edges: [live(0.335), live(0.748)] }, 1083)).toBe(true);
    expect(legCarriesLiveSpeeds({ edges: [live(0.335), unmeasured(0.748)] }, 1083)).toBe(false);
    expect(legCarriesLiveSpeeds({ edges: [live(0.335), live(0.748, 0)] }, 1083)).toBe(false);
  });

  it("reads lengths in the units the engine answered in", () => {
    expect(legCarriesLiveSpeeds({ units: "miles", edges: [live(0.673)] }, 1083)).toBe(true);
    expect(legCarriesLiveSpeeds({ units: "furlongs", edges: [live(5)] }, 1083)).toBeNull();
  });

  it("cannot say when the trace is empty, malformed or does not add up to the leg", () => {
    expect(legCarriesLiveSpeeds({ edges: [] }, 1083)).toBeNull();
    expect(legCarriesLiveSpeeds({}, 1083)).toBeNull();
    expect(legCarriesLiveSpeeds({ edges: [{ length: "1" }] }, 1083)).toBeNull();
    // Half the leg: the walk stopped short of the route it was asked about.
    expect(legCarriesLiveSpeeds({ edges: [live(0.5)] }, 1083)).toBeNull();
  });
});

describe("traceRouteCoverage", () => {
  it("walks each leg's own shape exactly against the live write", async () => {
    const { post, bodies } = engine(() => [live(1.083)]);
    await traceRouteCoverage(
      route([LEG_A]),
      routeProof,
      { speed_types: ["freeflow", "constrained", "predicted", "current"] },
      post,
      () => NOW,
    );
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as Record<string, unknown>;
    expect(body).toMatchObject({
      shape_match: "edge_walk",
      costing: "auto",
      costing_options: {
        auto: { speed_types: ["freeflow", "constrained", "predicted", "current"] },
      },
      date_time: { type: 0 },
    });
    expect(body.openmapx_request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(decodePolyline(body.encoded_polyline as string, 6)).toEqual(LEG_A.geometry);
  });

  it("is complete when every leg carried live speeds under the route's own write", async () => {
    const { post } = engine((index) => (index === 0 ? [live(1.083)] : [live(0.9)]));
    expect(
      await traceRouteCoverage(route([LEG_A, LEG_B]), routeProof, {}, post, () => NOW),
    ).toEqual({
      complete: true,
      evaluatedAt: routeProof.evaluatedAt,
      // The earliest of the route's and the traces' leases.
      validUntil: at(60_000),
    });
  });

  it("is incomplete when any edge lacked a current speed", async () => {
    const { post } = engine((index) => (index === 0 ? [live(1.083)] : [unmeasured(0.9)]));
    expect(
      await traceRouteCoverage(route([LEG_A, LEG_B]), routeProof, {}, post, () => NOW),
    ).toMatchObject({ complete: false });
  });

  it("stays unknown unless the trace was answered from the route's own write and engine", async () => {
    for (const proof of [
      { writeId: "write-2" },
      { graphGeneration: "graph-2" },
      { engineBootId: "boot-2" },
      { endpoint: "route" as const },
      { costing: "motorcycle" as const },
      { validUntil: at(-1) },
    ]) {
      const { post } = engine(() => [live(1.083)], proof);
      expect(await traceRouteCoverage(route([LEG_A]), routeProof, {}, post, () => NOW)).toBe(
        undefined,
      );
    }
  });

  it("stays unknown when a trace fails or carries no proof", async () => {
    const failing = async () => {
      throw new Error("Valhalla coverage trace error 400");
    };
    expect(await traceRouteCoverage(route([LEG_A]), routeProof, {}, failing, () => NOW)).toBe(
      undefined,
    );
    const unproven = async () => ({ units: "kilometers", edges: [live(1.083)] });
    expect(await traceRouteCoverage(route([LEG_A]), routeProof, {}, unproven, () => NOW)).toBe(
      undefined,
    );
  });

  it("stays unknown once the route's own lease has ended", async () => {
    const { post } = engine(() => [live(1.083)]);
    const ended = { ...routeProof, validUntil: at(-1) };
    expect(await traceRouteCoverage(route([LEG_A]), ended, {}, post, () => NOW)).toBe(undefined);
  });

  it("does not trace a trip with more legs than the bound", async () => {
    const { post, bodies } = engine(() => [live(1.083)]);
    const many = Array.from({ length: MAX_COVERAGE_TRACES + 1 }, () => LEG_A);
    expect(await traceRouteCoverage(route(many), routeProof, {}, post, () => NOW)).toBe(undefined);
    expect(bodies).toHaveLength(0);
  });
});
