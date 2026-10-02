import { readdirSync, readFileSync } from "node:fs";
import { type RoadConditionEffect, readRoadConditionEffects } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import de from "../../../packages/i18n/locales/de.json";
import en from "../../../packages/i18n/locales/en.json";
import {
  applicabilityText,
  effectLines,
  effectStateText,
  hasRestrictionEvidence,
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
const AT = new Date("2026-09-11T12:00:00Z");
const options = { translate, locale: "en", at: AT };
const lines = (effects: RoadConditionEffect[], over = {}) =>
  effectLines(situation({ effects, ...over }), options);

describe("effectLines", () => {
  it("phrases each effect kind in plain words", () => {
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
      "Closed: Ramp · in force",
      "Lanes: 2 of 3 lanes closed · in force",
      "Lanes: 1 closed · in force",
      "Lanes: Single lane alternating · in force",
      "Speed limit: 60 km/h (advisory) · in force",
      "Delay: +15 min, queue 3 km · in force",
      "Access: Permit only R2 · in force",
      "Dangerous goods: prohibited, ADR tunnel category C, UN classes 1, 7 · in force",
      "Detour: via B 9, signposted · in force",
      "Contraflow · in force",
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
      "Vehicle limit: Height less than 4.5 m (physical limit) · in force",
      "Vehicle limit: Gross weight at most 26 t · in force",
    ]);
  });

  it("states each effect's own window at the instant shown", () => {
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
      "Closed: Road · in force",
      "Closed: Road · from 2026-09-12T20:00:00Z",
      "Closed: Road · ended",
      "Closed: Road · ended",
      "Closed: Road · not in force now",
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
      "Closed: Road · Heavy goods vehicles, Buses (with conditions) except Emergency vehicles · in force",
      "Closed: Road · except Buses · in force",
      "Closed: Road · Vehicles not specified: LKW > 7,5 t · in force · partly interpreted",
    ]);
  });

  it("marks advice and partly read rules, and says when a rule could not be read", () => {
    expect(
      lines([
        effect("1", "speed_limit", { limit: { value: 80, unit: "km/h" }, compliance: "advisory" }),
        effect("2", "closure", { normalization: "partial" }),
        effect("3", "unsupported", { normalization: "unsupported" }),
        effect("4", "advisory", { text: [{ lang: "en", text: "Expect delays" }] }),
      ]),
    ).toEqual([
      "Speed limit: 80 km/h · in force · advisory",
      "Closed: Road · in force · partly interpreted",
      "Restriction: details could not be interpreted · in force",
      "Advice: Expect delays · in force",
    ]);
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
    ];
    expect(() =>
      effectLines(situation({ effects: every }), { ...options, translate: german }),
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
      expect(() => effectLines(situation({ effects }), options)).not.toThrow();
    });
  }
});
