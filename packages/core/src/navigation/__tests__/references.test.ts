import { describe, expect, it } from "vitest";
import type { RouteStep } from "../../types/routing";
import { chooseReference, type LandmarkReference, trafficLightReference } from "../references";

const MANEUVER = 1000;
const PUCK = 700;

describe("trafficLightReference", () => {
  it("two signal nodes at one junction count once", () => {
    expect(trafficLightReference([990, 1000], PUCK, MANEUVER)).toBe(1);
    expect(trafficLightReference([960, 995], PUCK, MANEUVER)).toBe(1);
  });

  it("the second junction gives ordinal 2", () => {
    expect(trafficLightReference([850, 995], PUCK, MANEUVER)).toBe(2);
    expect(trafficLightReference([840, 860, 985, 998], PUCK, MANEUVER)).toBe(2);
  });

  it("the third junction gives ordinal 3", () => {
    expect(trafficLightReference([760, 880, 990], PUCK, MANEUVER)).toBe(3);
  });

  it("a signal 21 m before the turn gives none", () => {
    expect(trafficLightReference([979], PUCK, MANEUVER)).toBeNull();
    expect(trafficLightReference([980], PUCK, MANEUVER)).toBe(1);
  });

  it("four junctions give none", () => {
    expect(trafficLightReference([750, 830, 910, 995], PUCK, MANEUVER)).toBeNull();
  });

  it("the 15 m puck margin skips the light being passed", () => {
    expect(trafficLightReference([710, 995], PUCK, MANEUVER)).toBe(1);
    expect(trafficLightReference([715, 995], PUCK, MANEUVER)).toBe(2);
  });

  it("does not count a junction the puck is already inside", () => {
    // One junction's signals at 705 and 740: the driver stands at it.
    expect(trafficLightReference([705, 740, 995], PUCK, MANEUVER)).toBe(1);
  });

  it("ignores signals past the manoeuvre, keeping the far stop line in its junction", () => {
    expect(trafficLightReference([995, 1008], PUCK, MANEUVER)).toBe(1);
    expect(trafficLightReference([1030], PUCK, MANEUVER)).toBeNull();
  });

  it("accepts unsorted input and gives none without signals", () => {
    expect(trafficLightReference([995, 850], PUCK, MANEUVER)).toBe(2);
    expect(trafficLightReference([], PUCK, MANEUVER)).toBeNull();
  });

  it("gives none when the turn's own junction is within the puck margin", () => {
    expect(trafficLightReference([990], 980, MANEUVER)).toBeNull();
  });
});

const step = (modifier: string | undefined, extra: Partial<RouteStep> = {}): RouteStep =>
  ({
    instruction: "Turn",
    distance: 300,
    duration: 30,
    coordinates: [],
    maneuver: { type: "turn", ...(modifier && { modifier }) },
    ...extra,
  }) as RouteStep;

const landmark: LandmarkReference = { stepIndex: 1, category: "fuel", brand: "Aral" };

const input = (overrides: Partial<Parameters<typeof chooseReference>[0]> = {}) => ({
  steps: [step(undefined, { maneuver: { type: "depart" } }), step("right"), step("left")],
  stepIndex: 1,
  maneuverAlong: MANEUVER,
  puckAlong: PUCK,
  signalsAlong: [850, 995],
  fetchedSpans: [{ from: 0, to: 5000 }],
  landmark: null,
  ...overrides,
});

describe("chooseReference", () => {
  it("names the traffic light for a turn", () => {
    expect(chooseReference(input())).toEqual({ kind: "traffic-light", ordinal: 2 });
  });

  it("traffic light wins over landmark", () => {
    expect(chooseReference(input({ landmark }))).toEqual({ kind: "traffic-light", ordinal: 2 });
  });

  it("falls back to the landmark without a traffic light", () => {
    expect(chooseReference(input({ landmark, signalsAlong: [400] }))).toEqual({
      kind: "landmark",
      category: "fuel",
      brand: "Aral",
    });
    expect(
      chooseReference(
        input({ landmark: { stepIndex: 1, category: "church" }, signalsAlong: null }),
      ),
    ).toEqual({ kind: "landmark", category: "church" });
  });

  it("ignores a landmark for another manoeuvre", () => {
    expect(
      chooseReference(input({ landmark: { ...landmark, stepIndex: 2 }, signalsAlong: null })),
    ).toBeNull();
  });

  it("no reference across an unfetched window", () => {
    expect(chooseReference(input({ fetchedSpans: [] }))).toBeNull();
    expect(chooseReference(input({ fetchedSpans: [{ from: 0, to: 900 }] }))).toBeNull();
    expect(
      chooseReference(
        input({
          fetchedSpans: [
            { from: 0, to: 800 },
            { from: 850, to: 2000 },
          ],
        }),
      ),
    ).toBeNull();
    // Adjacent windows cover the span together.
    expect(
      chooseReference(
        input({
          fetchedSpans: [
            { from: 800, to: 2000 },
            { from: 0, to: 800 },
          ],
        }),
      ),
    ).toEqual({ kind: "traffic-light", ordinal: 2 });
  });

  it("an unfetched window still allows the landmark", () => {
    expect(chooseReference(input({ fetchedSpans: [], landmark }))).toEqual({
      kind: "landmark",
      category: "fuel",
      brand: "Aral",
    });
  });

  it("u-turns and motorway steps get none", () => {
    const uturn = input({
      steps: [step(undefined), step("uturn", { maneuver: { type: "uturn", modifier: "left" } })],
      landmark,
    });
    expect(chooseReference(uturn)).toBeNull();
    const motorwayIn = input({
      steps: [step(undefined, { motorway: true }), step("right")],
      landmark,
    });
    expect(chooseReference(motorwayIn)).toBeNull();
    const motorwayOut = input({ steps: [step(undefined), step("right", { motorway: true })] });
    expect(chooseReference(motorwayOut)).toBeNull();
  });

  it("accepts every turn modifier spelling and refuses straight on", () => {
    for (const modifier of ["slight-left", "sharp_right", "slight right", "Left"]) {
      expect(
        chooseReference(input({ steps: [step(undefined), step(modifier)] })),
        modifier,
      ).not.toBeNull();
    }
    for (const modifier of ["straight", "uturn", undefined]) {
      expect(
        chooseReference(input({ steps: [step(undefined), step(modifier)] })),
        String(modifier),
      ).toBeNull();
    }
    const arrive = step("right", { maneuver: { type: "arrive", modifier: "right" } });
    expect(chooseReference(input({ steps: [step(undefined), arrive] }))).toBeNull();
  });

  it("gives none for a missing step", () => {
    expect(chooseReference(input({ stepIndex: 7, landmark }))).toBeNull();
  });
});
