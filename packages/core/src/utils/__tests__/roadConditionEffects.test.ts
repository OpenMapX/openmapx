import { describe, expect, it } from "vitest";
import {
  bindsEveryCar,
  closesRoadForCars,
  effectInForceAt,
  localizedTextFor,
  readRoadConditionEffects,
  speedCapKph,
  validityHoldsAt,
} from "../roadConditionEffects";
import { effect, event } from "./fixtures/roadCondition";

describe("readRoadConditionEffects", () => {
  it("keeps every effect it can read, with fields a newer producer added", () => {
    const [read] = readRoadConditionEffects([
      { ...effect("a/closure", "closure"), futureField: { x: 1 } },
    ]);
    expect(read).toMatchObject({ id: "a/closure", kind: "closure", scope: "road" });
  });

  it("turns an effect it cannot read into unsupported restriction evidence, keeping its id", () => {
    expect(
      readRoadConditionEffects([
        { ...effect("a/teleport", "closure"), kind: "teleport" },
        { ...effect("a/limit", "speed_limit") },
        "nonsense",
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "a/teleport",
        kind: "unsupported",
        applicability: { kind: "unknown" },
        normalization: "unsupported",
      }),
      expect.objectContaining({ id: "a/limit", kind: "unsupported" }),
      expect.objectContaining({ id: "effects[2]", kind: "unsupported" }),
    ]);
    expect(readRoadConditionEffects(undefined)).toEqual([]);
  });
});

describe("what an effect does to cars", () => {
  it("binds every car only when no vehicle could be spared", () => {
    expect(bindsEveryCar({ kind: "all" })).toBe(true);
    expect(bindsEveryCar({ kind: "classes", include: [{ class: "car" }] })).toBe(true);
    expect(
      bindsEveryCar({
        kind: "classes",
        include: [
          {
            class: "car",
            when: [
              { dimension: "gross_weight", operator: "gt", value: { value: 3500, unit: "kg" } },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(bindsEveryCar({ kind: "classes", include: [{ class: "hgv" }] })).toBe(false);
    expect(bindsEveryCar({ kind: "all", except: [{ usage: "residents" }] })).toBe(false);
    expect(bindsEveryCar({ kind: "unknown" })).toBe(false);
  });

  it("closes the road for a carriageway closure or every lane closed, not for a cycleway", () => {
    expect(closesRoadForCars(effect("c", "closure"))).toBe(true);
    expect(closesRoadForCars(effect("c", "closure", { scope: "cycleway" }))).toBe(false);
    expect(
      closesRoadForCars(effect("l", "lane_restriction", { vehicleImpact: "all_lanes_closed" })),
    ).toBe(true);
    expect(
      closesRoadForCars(effect("l", "lane_restriction", { vehicleImpact: "some_lanes_closed" })),
    ).toBe(false);
    expect(closesRoadForCars(effect("c", "closure", { normalization: "partial" }))).toBe(false);
    expect(
      closesRoadForCars(
        effect("c", "closure", { applicability: { kind: "classes", include: [{ class: "hgv" }] } }),
      ),
    ).toBe(false);
  });

  it("caps speed by a mandatory limit only", () => {
    const limit = (fields: Record<string, unknown>) =>
      effect("s", "speed_limit", { limit: { value: 60, unit: "km/h" }, ...fields });
    expect(speedCapKph(limit({}))).toBe(60);
    expect(speedCapKph(limit({ advisory: true }))).toBeUndefined();
    expect(speedCapKph(limit({ applicability: { kind: "unknown" } }))).toBeUndefined();
    expect(speedCapKph(effect("c", "closure"))).toBeUndefined();
  });
});

describe("when an effect is in force", () => {
  it("holds inside its bounds, not when ended, cancelled or outside them", () => {
    const at = new Date("2026-09-11T12:00:00Z");
    expect(validityHoldsAt({ status: "active", start: "2026-09-11T08:00:00Z" }, at)).toBe(true);
    expect(validityHoldsAt({ status: "active", end: "2026-09-11T11:00:00Z" }, at)).toBe(false);
    expect(validityHoldsAt({ status: "active", start: "2026-09-12T00:00:00Z" }, at)).toBe(false);
    expect(validityHoldsAt({ status: "cancelled" }, at)).toBe(false);
  });

  it("holds a nightly window in its own time zone, across midnight, and not in an exception", () => {
    const nightly = {
      status: "active" as const,
      periods: [{ startTime: "22:00", duration: "PT6H", scheduleTimezone: "Europe/Paris" }],
    };
    // 23:30 and 03:30 Paris (CEST, UTC+2) are inside; 12:00 is not.
    expect(validityHoldsAt(nightly, new Date("2026-09-11T21:30:00Z"))).toBe(true);
    expect(validityHoldsAt(nightly, new Date("2026-09-12T01:30:00Z"))).toBe(true);
    expect(validityHoldsAt(nightly, new Date("2026-09-11T10:00:00Z"))).toBe(false);
    const sundaysOff = {
      ...nightly,
      exceptions: [{ byDay: ["SU"], scheduleTimezone: "Europe/Paris" }],
    };
    expect(validityHoldsAt(sundaysOff, new Date("2026-09-12T21:30:00Z"))).toBe(true);
    expect(validityHoldsAt(sundaysOff, new Date("2026-09-13T21:30:00Z"))).toBe(false);
  });

  it("holds a one-off window longer than a day throughout, and not after it ends", () => {
    // How OpenConditions writes a DATEX period: one start day, a long duration.
    const works = {
      status: "active" as const,
      periods: [
        {
          startDate: "2026-09-10",
          endDate: "2026-09-10",
          startTime: "06:00",
          duration: "P3DT9H",
          scheduleTimezone: "Europe/Paris",
        },
      ],
    };
    // Starts 2026-09-10 04:00Z, ends 2026-09-13 13:00Z.
    expect(validityHoldsAt(works, new Date("2026-09-12T12:00:00Z"))).toBe(true);
    expect(validityHoldsAt(works, new Date("2026-09-13T12:59:00Z"))).toBe(true);
    expect(validityHoldsAt(works, new Date("2026-09-13T13:00:00Z"))).toBe(false);
    expect(validityHoldsAt(works, new Date("2026-09-10T03:59:00Z"))).toBe(false);
  });

  it("evaluates an effect against its own window, else its situation's", () => {
    const e = event();
    const phase = effect("p", "closure", {
      validity: { status: "active", start: "2026-09-20T00:00:00Z" },
    });
    const at = new Date("2026-09-11T12:00:00Z");
    expect(effectInForceAt(e, e.effects[0]!, at)).toBe(true);
    expect(effectInForceAt(e, phase, at)).toBe(false);
  });
});

describe("localizedTextFor", () => {
  const text = [
    { lang: "nl", text: "Weg dicht" },
    { lang: "en-GB", text: "Road closed" },
  ];
  it("picks the locale, then its base language, then the publisher's own", () => {
    expect(localizedTextFor(text, "en-GB")).toBe("Road closed");
    expect(localizedTextFor(text, "en")).toBe("Road closed");
    expect(localizedTextFor(text, "de")).toBe("Weg dicht");
    expect(localizedTextFor(undefined, "de")).toBeUndefined();
  });
});
