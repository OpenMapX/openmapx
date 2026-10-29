import { readdirSync, readFileSync } from "node:fs";
import { type RoadConditionEffect, readRoadConditionEffects } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import de from "../../../packages/i18n/locales/de.json";
import en from "../../../packages/i18n/locales/en.json";
import {
  applicabilityText,
  effectStateText,
  hasRestrictionEvidence,
  impactLines,
} from "../effects";
import { effect, situation } from "./fixtures";

/**
 * The translator is the real road-conditions dictionary, so a key the
 * formatter asks for but the catalog lacks fails here rather than showing up
 * as a raw key in a popup. Placeholders render as `{name}=value`.
 */
function dictionaryTranslate(catalog: unknown) {
  const root = (catalog as { roadConditions: Record<string, unknown> }).roadConditions;
  return (key: string, values?: Record<string, string | number>) => {
    let node: unknown = root;
    for (const part of key.split(".")) {
      node =
        node !== null && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined;
    }
    if (typeof node !== "string") throw new Error(`missing road-conditions string: ${key}`);
    return Object.entries(values ?? {}).reduce(
      (out, [name, value]) => out.replace(`{${name}}`, String(value)),
      node,
    );
  };
}

const translate = dictionaryTranslate(en);
const DELAY_BAND_CODES = [
  "negligible",
  "up_to_ten_minutes",
  "between_ten_minutes_and_thirty_minutes",
  "between_thirty_minutes_and_one_hour",
  "between_one_hour_and_three_hours",
  "between_three_hours_and_six_hours",
  "longer_than_six_hours",
];
const AT = new Date("2026-09-11T12:00:00Z");
const options = { translate, locale: "en", at: AT };
const lines = (effects: RoadConditionEffect[], over = {}) =>
  impactLines(situation({ effects, ...over }), options);

describe("impactLines", () => {
  it("phrases each effect kind in plain words, most disruptive first", () => {
    expect(
      lines([
        effect("1", "closure", { scope: "ramp" }),
        effect("2", "lane_restriction", { lanesClosed: 2, lanesTotal: 3, vehicleImpact: "x" }),
        effect("3", "lane_restriction", { lanesClosed: 1, vehicleImpact: "x" }),
        effect("4", "lane_restriction", { vehicleImpact: "single_lane_alternating" }),
        effect("5", "speed_limit", { limit: { value: 60, unit: "km/h" }, advisory: true }),
        effect("6", "delay", {
          delay: { value: 900, unit: "s" },
          queueLength: { value: 3, unit: "km" },
        }),
        effect("7", "access", { mode: "permit_only", chainLevel: "R2" }),
        effect("8", "hazmat", {
          mode: "prohibited",
          adrTunnelCategory: "C",
          unClasses: ["1", "7"],
        }),
        effect("9", "detour", { via: [{ ref: "B 9" }], signed: true }),
        effect("10", "contraflow"),
      ]),
    ).toEqual([
      "Ramp closed",
      "2 of 3 lanes closed",
      "1 closed",
      "Single lane alternating",
      "Access: Permit only R2",
      "Dangerous goods: prohibited, ADR tunnel category C, UN classes 1, 7",
      "Speed limit: 60 km/h (advisory)",
      "Contraflow",
      "Delay: +15 min, queue 3 km",
      "Detour: via B 9, signposted",
    ]);
  });

  it("tells restricted lanes from closed ones and counts the lanes left open", () => {
    const lanes = (fields: Record<string, unknown>) =>
      lines([effect("l", "lane_restriction", { vehicleImpact: "some_lanes_closed", ...fields })]);
    expect(lanes({ lanesRestricted: 2, lanesTotal: 3, lanesOperational: 1 })).toEqual([
      "2 of 3 lanes restricted, 1 open",
    ]);
    expect(lanes({ lanesRestricted: 2, lanesClosed: 1, lanesTotal: 3 })).toEqual([
      "2 of 3 lanes restricted, 1 closed",
    ]);
    expect(lanes({ lanesRestricted: 1, lanesClosed: 1, lanesTotal: 3 })).toEqual([
      "1 of 3 lanes closed",
    ]);
    expect(lanes({ lanesRestricted: 1 })).toEqual(["1 restricted"]);
    expect(
      lanes({
        lanes: [
          { index: 1, status: "closed" },
          { index: 2, status: "narrowed" },
          { index: 3, status: "open" },
        ],
      }),
    ).toEqual(["2 restricted, 1 closed"]);
  });

  it("gives a delay's band or description where its length is not known", () => {
    const delay = (fields: Record<string, unknown>) => lines([effect("d", "delay", fields)]);
    expect(delay({ delayBand: "between_ten_minutes_and_thirty_minutes" })).toEqual([
      "Delay: 10–30 min",
    ]);
    expect(
      delay({ delayBand: "between_one_hour_and_three_hours", delayType: "long_delays" }),
    ).toEqual(["Delay: 1–3 h, long"]);
    expect(delay({ delayType: "delays_of_uncertain_duration" })).toEqual([
      "Delay: duration uncertain",
    ]);
    expect(delay({ delayType: "delays" })).toEqual(["Delay"]);
    // An exact delay wins over its band; a band or description this host does not know reads plainly.
    expect(delay({ delay: { value: 600, unit: "s" }, delayBand: "longer_than_six_hours" })).toEqual(
      ["Delay: +10 min"],
    );
    expect(delay({ delayBand: "a_fortnight", delayType: "glacial_delays" })).toEqual([
      "Delay: A fortnight, Glacial delays",
    ]);
  });

  it("spells out a comparator instead of passing it off as a limit", () => {
    expect(
      lines([
        effect("h", "dimension_limit", {
          dimension: "height",
          value: { value: 4.5, unit: "m" },
          operator: "lt",
          meaning: "physical_limit",
        }),
        effect("w", "dimension_limit", {
          dimension: "gross_weight",
          value: { value: 26000, unit: "kg" },
          operator: "lte",
          meaning: "maximum_permitted",
        }),
      ]),
    ).toEqual([
      "Vehicle limit: Height less than 4.5 m (physical limit)",
      "Vehicle limit: Gross weight at most 26 t",
    ]);
  });

  it("says when an effect of a running situation is not in force, and drops ended ones", () => {
    const base = { validity: { status: "active" as const, start: "2026-09-01T00:00:00Z" } };
    expect(
      lines(
        [
          effect("a", "closure"),
          effect("b", "closure", {
            validity: { status: "planned", start: "2026-09-12T20:00:00Z" },
          }),
          effect("c", "closure", { validity: { status: "active", end: "2026-09-10T00:00:00Z" } }),
          effect("d", "closure", { validity: { status: "cancelled" } }),
          effect("e", "closure", {
            validity: {
              status: "active",
              periods: [{ startTime: "22:00", duration: "PT6H", scheduleTimezone: "UTC" }],
            },
          }),
        ],
        base,
      ),
    ).toEqual([
      "Road closed",
      "Road closed · from 2026-09-12T20:00:00Z",
      "Road closed · not in force now",
    ]);
  });

  it("names the vehicles a rule binds, and never widens an unknown scope", () => {
    expect(
      lines([
        effect("1", "closure", {
          applicability: {
            kind: "classes",
            include: [{ class: "hgv" }, { class: "bus", when: [] }],
            except: [{ class: "emergency" }],
          },
        }),
        effect("2", "closure", { applicability: { kind: "all", except: [{ class: "bus" }] } }),
        effect("3", "closure", { applicability: { kind: "unknown", raw: ["LKW > 7,5 t"] } }),
      ]),
    ).toEqual([
      "Road closed · Heavy goods vehicles, Buses (with conditions) except Emergency vehicles",
      "Road closed · except Buses",
      "Road closed · LKW > 7,5 t",
    ]);
  });

  it("marks advice, and leaves out a rule that could not be read", () => {
    expect(
      lines([
        effect("1", "speed_limit", { limit: { value: 80, unit: "km/h" }, compliance: "advisory" }),
        effect("2", "closure", { normalization: "partial" }),
        effect("3", "unsupported", { normalization: "unsupported" }),
        effect("4", "advisory", { text: [{ lang: "en", text: "Expect delays" }] }),
      ]),
    ).toEqual(["Road closed", "Speed limit: 80 km/h · advisory", "Advice: Expect delays"]);
  });

  it("asks only for strings the German catalog has too", () => {
    const german = dictionaryTranslate(de);
    const every = [
      effect("1", "closure"),
      effect("2", "lane_restriction", { lanesClosed: 1, lanesTotal: 2, vehicleImpact: "x" }),
      effect("3", "speed_limit", { limit: { value: 30, unit: "km/h" }, advisory: true }),
      effect("4", "dimension_limit", {
        applicability: { kind: "unknown" },
        dimension: "axle_load",
        value: { value: 10000, unit: "kg" },
        operator: "lt",
        meaning: "physical_limit",
      }),
      effect("5", "hazmat", { mode: "restricted", adrTunnelCategory: "E" }),
      effect("6", "unsupported"),
      effect("7", "lane_restriction", {
        lanesRestricted: 2,
        lanesClosed: 1,
        lanesTotal: 3,
        lanesOperational: 1,
        vehicleImpact: "x",
      }),
      effect("8", "lane_restriction", { lanesRestricted: 2, vehicleImpact: "x" }),
      ...[...DELAY_BAND_CODES, "x"].map((delayBand, i) =>
        effect(`9.${i}`, "delay", { delayBand, delayType: "very_long_delays" }),
      ),
      effect("10", "delay", { delayType: "long_delays" }),
      effect("11", "delay", { delayType: "delays_of_uncertain_duration" }),
    ];
    expect(() =>
      impactLines(situation({ effects: every }), { ...options, translate: german }),
    ).not.toThrow();
  });
});

describe("applicabilityText", () => {
  it("is silent for every vehicle", () => {
    expect(applicabilityText({ kind: "all" }, translate)).toBeUndefined();
  });

  it("humanizes a class the catalog does not know", () => {
    expect(
      applicabilityText({ kind: "classes", include: [{ class: "tram" as "car" }] }, translate),
    ).toBe("Tram");
  });
});

describe("effectStateText", () => {
  it("evaluates the situation's validity when the effect has none", () => {
    const event = situation({ validity: { status: "planned", start: "2026-09-20T00:00:00Z" } });
    expect(effectStateText(event, effect("c", "closure"), options)).toBe(
      "from 2026-09-20T00:00:00Z",
    );
  });

  it("says in force only when the effect is, naming the lifecycle that holds it out", () => {
    const state = (status: "planned" | "suspended" | "unknown" | "active") =>
      effectStateText(
        situation({ validity: { status, start: "2026-09-01T00:00:00Z" } }),
        effect("c", "closure"),
        options,
      );
    expect(state("active")).toBe("in force");
    expect(state("planned")).toBe("planned, not yet in force");
    expect(state("suspended")).toBe("suspended, not in force");
    expect(state("unknown")).toBe("status unknown, not treated as in force");
  });

  it("reads an effect as ended at the very instant its window ends", () => {
    const event = situation({ validity: { status: "active", end: AT.toISOString() } });
    expect(effectStateText(event, effect("c", "closure"), options)).toBe("ended");
  });

  it("says when an operator action is not in place, and nothing more when it is", () => {
    const state = (actionStatus: string) =>
      effectStateText(situation(), effect("c", "closure", { actionStatus }), options);
    expect(state("requested")).toBe("requested, not in place");
    expect(state("approved")).toBe("approved, not yet in place");
    expect(state("rejected")).toBe("rejected, not in place");
    expect(state("being_terminated")).toBe("in force");
  });

  it("finds every state text in the German catalog too", () => {
    const german = { ...options, translate: dictionaryTranslate(de) };
    for (const status of ["planned", "suspended", "unknown"] as const) {
      const event = situation({ validity: { status } });
      expect(() => effectStateText(event, effect("c", "closure"), german)).not.toThrow();
    }
    for (const actionStatus of ["requested", "approved", "rejected"]) {
      const pending = effect("c", "closure", { actionStatus });
      expect(() => effectStateText(situation(), pending, german)).not.toThrow();
    }
  });
});

describe("hasRestrictionEvidence", () => {
  it("holds when any effect's vehicles or meaning were not fully read", () => {
    expect(hasRestrictionEvidence({ effects: [effect("a", "closure")] })).toBe(false);
    expect(
      hasRestrictionEvidence({
        effects: [
          effect("a", "closure"),
          effect("b", "closure", { applicability: { kind: "unknown" } }),
        ],
      }),
    ).toBe(true);
  });
});

/**
 * Every effect the producer's checked-in contract goldens publish must read on
 * this host as itself — not fall back to `unsupported` — and format with the
 * real catalog. A producer effect shape this host cannot show fails here.
 */
describe("producer contract goldens", () => {
  const dir = new URL(
    "../../../services/data-manager/src/__tests__/fixtures/contracts/",
    import.meta.url,
  );
  const goldens = readdirSync(dir).filter((name) => name.endsWith(".json"));

  it("finds the goldens", () => {
    expect(goldens.length).toBeGreaterThan(0);
  });

  for (const name of goldens) {
    it(`reads and formats every effect of ${name}`, () => {
      const golden = JSON.parse(readFileSync(new URL(name, dir), "utf8")) as {
        conditions?: Array<{ effect?: { kind?: string } }>;
      };
      const raw = (golden.conditions ?? []).map((condition) => condition.effect);
      const effects = readRoadConditionEffects(raw);
      expect(effects.map((e) => e.kind)).toEqual(raw.map((e) => e?.kind));
      expect(() => impactLines(situation({ effects }), options)).not.toThrow();
    });
  }
});
