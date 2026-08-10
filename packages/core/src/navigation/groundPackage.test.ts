import { describe, expect, it } from "vitest";
import type { Route } from "../types/routing";
import { buildGroundNavigationPackage, groundRouteFingerprint } from "./groundPackage";

function route(overrides: Partial<Route> = {}): Route {
  return {
    distance: 1_000,
    duration: 120,
    geometry: [
      [8.68, 50.11],
      [8.69, 50.12],
      [8.7, 50.13],
    ],
    steps: [],
    legs: [],
    mode: "driving",
    ...overrides,
  } as unknown as Route;
}

const input = (overrides: Record<string, unknown> = {}) => ({
  route: route(),
  mode: "driving" as const,
  destinationWaypoints: [
    [8.68, 50.11],
    [8.7, 50.13],
  ] as [number, number][],
  routeSelectionIntent: "automatic" as const,
  locale: "en" as const,
  units: "metric" as const,
  settings: { voiceEnabled: true, keepScreenOn: true, voiceTiming: "normal" as const },
  ...overrides,
});

describe("buildGroundNavigationPackage", () => {
  it("builds a package the protocol accepts", () => {
    const result = buildGroundNavigationPackage(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.startPackage.kind).toBe("ground");
    expect(result.startPackage.route.geometry).toHaveLength(3);
  });

  it("preserves the provider, options, alternatives and waypoints", () => {
    const result = buildGroundNavigationPackage(
      input({
        routeProvider: "valhalla",
        routeOptions: { avoidTolls: true },
        alternatives: [route({ distance: 1_200 })],
        routeSelectionIntent: "userSelected",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.startPackage.routeProvider).toBe("valhalla");
    expect(result.startPackage.routeOptions).toEqual({ avoidTolls: true });
    expect(result.startPackage.alternatives).toHaveLength(1);
    expect(result.startPackage.destinationWaypoints).toHaveLength(2);
    expect(result.startPackage.routeSelectionIntent).toBe("userSelected");
  });

  it("carries no field the schema does not name", () => {
    const contaminated = route() as unknown as Record<string, unknown>;
    contaminated.queryClient = { cache: "should not cross" };
    contaminated.authorization = "Bearer secret";

    const result = buildGroundNavigationPackage(input({ route: contaminated }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The route schema passes unknown keys through, which is right for the
    // router and wrong for something written to durable native storage.
    const sent = result.startPackage.route as unknown as Record<string, unknown>;
    expect(sent.queryClient).toBeUndefined();
    expect(sent.authorization).toBeUndefined();
  });

  it("refuses a route with no line to follow", () => {
    expect(
      buildGroundNavigationPackage(input({ route: route({ geometry: [[8.68, 50.11]] }) })),
    ).toEqual({ ok: false, code: "no-geometry" });
  });

  it("refuses a trip with no destination", () => {
    expect(buildGroundNavigationPackage(input({ destinationWaypoints: [] }))).toEqual({
      ok: false,
      code: "no-destination",
    });
  });

  it("refuses locally rather than letting the shell reject an oversize trip", () => {
    const huge = route({
      geometry: Array.from({ length: 60_001 }, (_, index) => [8 + index * 1e-6, 50]) as never,
    });

    // Told before Start does anything, not seconds after the driver tapped it.
    expect(buildGroundNavigationPackage(input({ route: huge })).ok).toBe(false);
    expect(buildGroundNavigationPackage(input({ route: huge }))).toEqual({
      ok: false,
      code: "route-too-large",
    });
  });

  it("counts the alternatives towards the size it refuses", () => {
    const big = route({
      geometry: Array.from({ length: 40_000 }, (_, index) => [8 + index * 1e-6, 50]) as never,
    });

    expect(buildGroundNavigationPackage(input({ route: big, alternatives: [big] }))).toEqual({
      ok: false,
      code: "route-too-large",
    });
  });

  it("keeps at most the eight alternatives the protocol allows", () => {
    const result = buildGroundNavigationPackage(
      input({ alternatives: Array.from({ length: 12 }, () => route()) }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.startPackage.alternatives).toHaveLength(8);
  });
});

describe("groundRouteFingerprint", () => {
  it("is stable across equal routes", () => {
    expect(groundRouteFingerprint(route())).toBe(groundRouteFingerprint(route()));
  });

  it("changes when the followed line changes", () => {
    const rerouted = route({
      geometry: [
        [8.68, 50.11],
        [8.6805, 50.1105],
        [8.7, 50.13],
      ],
    });

    // Telling "same route, one revision on" from "different route" is what keeps
    // a progress delta off a line that is no longer there.
    expect(groundRouteFingerprint(rerouted)).not.toBe(groundRouteFingerprint(route()));
  });

  it("ignores float noise below about a centimetre", () => {
    const jittered = route({
      geometry: [
        [8.68 + 1e-12, 50.11],
        [8.69, 50.12],
        [8.7, 50.13],
      ],
    });

    expect(groundRouteFingerprint(jittered)).toBe(groundRouteFingerprint(route()));
  });
});
