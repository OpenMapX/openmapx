import type { RouteStep } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
// A walk from Alexanderplatz to Museum Island, Berlin, where sidewalks and the
// paths across the square are mapped as unnamed ways: Valhalla's route, the
// `trace_attributes` edge uses along its shape, and the `/locate` answers for
// the lookups the plan asks for (trimmed to distances, names and car access).
import fixture from "./__fixtures__/alexanderplatz-museum-island-walk.json" with { type: "json" };
import { setValhallaUrl, transformTrip, valhallaService } from "./provider.js";
import {
  composeWalkingSteps,
  nameLookups,
  nameStretches,
  nearestStreetName,
  planWalkingLeg,
  type WalkManeuver,
} from "./walking-guidance.js";

const leg = fixture.trip.legs[0];
const summary = (steps: RouteStep[]) =>
  steps.map((step) => [step.instruction, Math.round(step.distance)]);

function guide(lang: string, { edges = true, names = true } = {}) {
  const route = transformTrip(fixture.trip as never, "walking");
  const plan = planWalkingLeg(
    leg.maneuvers,
    route.legs[0].steps,
    route.legs[0].geometry,
    edges ? fixture.edges : undefined,
  );
  const lookups = nameLookups(plan);
  nameStretches(
    plan,
    lookups.map((lookup, i) => ({
      ...lookup,
      name: names ? nearestStreetName(fixture.locate[i]?.edges, lookup) : undefined,
    })),
  );
  return { lookups, steps: composeWalkingSteps(plan, lang) };
}

describe("walking guidance on an unnamed sidewalk network", () => {
  it("starts from Valhalla's 15 steps, eleven of them on 'the walkway'", () => {
    const steps = transformTrip(fixture.trip as never, "walking").steps;
    expect(steps).toHaveLength(15);
    expect(steps.filter((step) => step.instruction.includes("the walkway"))).toHaveLength(11);
  });

  it("asks for the streets the recorded lookups answered", () => {
    expect(guide("en").lookups.map(({ field, radius }) => [field, radius])).toEqual([
      ["name", 25],
      ["name", 25],
      ["crossed", 8],
      ["name", 25],
      ["crossed", 8],
      ["name", 25],
      ["crossed", 8],
    ]);
    expect(fixture.locate).toHaveLength(7);
  });

  it("names streets and crossings, folds jogs and keeps the arrival", () => {
    expect(summary(guide("en").steps)).toEqual([
      ["Head southwest on Alexanderplatz", 50],
      ["Turn left", 28],
      ["Turn right onto Dircksenstraße", 104],
      ["Cross the street", 24],
      ["Continue onto Rathausstraße", 390],
      ["Cross Spandauer Straße", 460],
      ["Bear right onto Schloßplatz", 50],
      ["Make a U-turn", 30],
      ["Cross Schloßplatz", 96],
      ["Turn left", 24],
      ["You have arrived at your destination.", 0],
    ]);
  });

  it("writes the same steps in German", () => {
    expect(
      guide("de")
        .steps.slice(0, -1)
        .map((step) => step.instruction),
    ).toEqual([
      "Auf Alexanderplatz Richtung Südwesten losgehen",
      "Links abbiegen",
      "Rechts abbiegen auf Dircksenstraße",
      "Straße überqueren",
      "Geradeaus auf Rathausstraße",
      "Spandauer Straße überqueren",
      "Leicht rechts auf Schloßplatz",
      "Wenden",
      "Schloßplatz überqueren",
      "Links abbiegen",
    ]);
  });

  it("keeps the walk's distance, time and geometry whole", () => {
    const original = transformTrip(fixture.trip as never, "walking");
    const { steps } = guide("en");
    const total = (list: RouteStep[], key: "distance" | "duration") =>
      list.reduce((sum, step) => sum + step[key], 0);
    expect(total(steps, "distance")).toBeCloseTo(total(original.steps, "distance"), 6);
    expect(total(steps, "duration")).toBeCloseTo(total(original.steps, "duration"), 6);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].coordinates[0]).toEqual(steps[i - 1].coordinates.at(-1));
    }
    expect(steps[0].coordinates[0]).toEqual(original.geometry[0]);
    expect(steps.at(-1)?.coordinates.at(-1)).toEqual(original.geometry.at(-1));
  });

  it("drops Valhalla's voice phrasings so the voice reads the new text", () => {
    for (const step of guide("en").steps.slice(0, -1)) {
      expect(step).not.toHaveProperty("verbalPre");
      expect(step).not.toHaveProperty("verbalAlert");
      expect(step).not.toHaveProperty("verbalPost");
      expect(step).not.toHaveProperty("verbalSuccinct");
    }
    expect(guide("en").steps.at(-1)?.verbalPre).toBe("You have arrived at your destination.");
  });

  it("still folds jogs and drops 'the walkway' when both lookups fail", () => {
    expect(summary(guide("en", { edges: false, names: false }).steps)).toEqual([
      ["Head southwest", 50],
      ["Turn left", 28],
      ["Turn right", 759],
      ["Continue onto Rathausstraße", 219],
      ["Bear right onto Schloßplatz", 50],
      ["Make a U-turn", 126],
      ["Turn left", 24],
      ["You have arrived at your destination.", 0],
    ]);
  });
});

describe("walking guidance rules", () => {
  // Three points due east, then north: a straight line with a turn at the end.
  const coordinates: [number, number][] = [
    [13.4, 52.5],
    [13.401, 52.5],
    [13.4011, 52.5],
    [13.4011, 52.5001],
    [13.4011, 52.501],
  ];
  const step = (distance: number): RouteStep => ({
    instruction: "Valhalla",
    distance,
    duration: distance,
    coordinates: [],
    verbalPre: "Valhalla",
  });
  const maneuver = (type: number, begin: number, end: number, name?: string): WalkManeuver => ({
    type,
    begin_shape_index: begin,
    end_shape_index: end,
    street_names: name ? [name] : undefined,
  });

  it("re-derives the turn after a folded jog from the heading before it", () => {
    // East 68 m, a 7 m jog east, a left turn of 11 m, then 100 m north: the
    // jog folds away and the left turn stays a left turn.
    const plan = planWalkingLeg(
      [maneuver(1, 0, 1, "Ost"), maneuver(8, 1, 2), maneuver(15, 2, 4, "Nord"), maneuver(4, 4, 4)],
      [step(68), step(7), step(111), step(0)],
      coordinates,
    );
    nameStretches(plan, []);
    expect(summary(composeWalkingSteps(plan, "en"))).toEqual([
      ["Head east on Ost", 75],
      ["Turn left onto Nord", 111],
      ["Valhalla", 0],
    ]);
  });

  it("says a turn stays on the street it leaves", () => {
    const plan = planWalkingLeg(
      [maneuver(1, 0, 2, "Ring"), maneuver(15, 2, 4, "Ring"), maneuver(4, 4, 4)],
      [step(75), step(111), step(0)],
      coordinates,
    );
    nameStretches(plan, []);
    expect(composeWalkingSteps(plan, "en")[1]?.instruction).toBe("Turn left to stay on Ring");
  });

  it("reads a crossed street only from a road that carries cars", () => {
    const sidewalk = { distance: 3, edge_info: { names: ["Hauptstraße"] }, edge: { access: {} } };
    const road = {
      distance: 6,
      edge_info: { names: ["Querstraße"] },
      edge: { access: { car: true } },
    };
    expect(nearestStreetName([sidewalk, road], { field: "crossed", radius: 8 })).toBe("Querstraße");
    expect(nearestStreetName([sidewalk, road], { field: "name", radius: 25 })).toBe("Hauptstraße");
    expect(nearestStreetName([road], { field: "crossed", radius: 5 })).toBeUndefined();
    expect(nearestStreetName(null, { field: "name", radius: 25 })).toBeUndefined();
  });
});

describe("valhallaService.getRoute walking guidance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setValhallaUrl(undefined);
  });

  function stubValhalla(answers: { traceFails?: boolean; locateFails?: boolean } = {}) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        calls.push(path);
        if (path === "/route") return Response.json({ trip: fixture.trip });
        if (path === "/trace_attributes") {
          return answers.traceFails
            ? new Response("down", { status: 503 })
            : Response.json({ edges: fixture.edges });
        }
        if (path === "/locate") {
          return answers.locateFails
            ? new Response("down", { status: 503 })
            : Response.json(fixture.locate);
        }
        return new Response("unexpected", { status: 404 });
      }),
    );
    setValhallaUrl("http://valhalla:8002");
    return calls;
  }

  const WALK: [number, number][] = [
    [13.41348, 52.52178],
    [13.39975, 52.51722],
  ];

  it("rewrites walking steps with one edge trace and one batched locate", async () => {
    const calls = stubValhalla();
    const result = await valhallaService.getRoute(WALK, "walking", { lang: "en" });
    expect(calls).toEqual(["/route", "/trace_attributes", "/locate"]);
    const route = result.routes[0];
    expect(route?.steps.map((step) => step.instruction)).toContain("Cross Spandauer Straße");
    expect(route?.legs[0]?.steps).toEqual(route?.steps);
    // Valhalla's summary names the first named maneuver, a 5 m jog onto Gontardstraße.
    expect(route?.summary).toBe("via Rathausstraße");
  });

  it("keeps the route when both lookups fail", async () => {
    stubValhalla({ traceFails: true, locateFails: true });
    const result = await valhallaService.getRoute(WALK, "walking", { lang: "en" });
    expect(result.routes[0]?.steps[0]?.instruction).toBe("Head southwest");
    expect(result.routes[0]?.steps).toHaveLength(8);
  });

  it("leaves other modes' steps to Valhalla", async () => {
    const calls = stubValhalla();
    const result = await valhallaService.getRoute(WALK, "cycling", { lang: "en" });
    expect(calls).toEqual(["/route"]);
    expect(result.routes[0]?.steps[0]?.instruction).toBe("Walk southwest on the walkway.");
  });
});
