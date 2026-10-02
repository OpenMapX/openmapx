import { validateReportClaim } from "@openmapx/openconditions-contrib-client";
import { describe, expect, it } from "vitest";
import {
  buildReportClaim,
  defaultSeverityForCategory,
  fuzzinessForChoice,
  generateNonce,
  REPORT_CATEGORIES,
  situationForCategory,
} from "../claim.js";

const CROWD_EFFECT_BASE = {
  v: 1,
  applicability: { kind: "all" },
  compliance: "mandatory",
  normalization: "complete",
};

describe("fuzzinessForChoice", () => {
  it("maps the four picker choices to the wire fuzziness values", () => {
    expect(fuzzinessForChoice("here")).toBe("exact");
    expect(fuzzinessForChoice("ahead")).toBe("end_unknown");
    expect(fuzzinessForChoice("back_of_queue")).toBe("start_unknown");
    expect(fuzzinessForChoice("all_along")).toBe("extent_unknown");
  });
});

describe("REPORT_CATEGORIES", () => {
  it("does not include police in the taxonomy", () => {
    expect(REPORT_CATEGORIES).not.toContain("police");
  });

  it("offers only categories that report as road situations", () => {
    expect(REPORT_CATEGORIES).not.toContain("transit_disruption");
    expect(REPORT_CATEGORIES).not.toContain("micromobility");
    expect(REPORT_CATEGORIES).not.toContain("accessibility");
    expect(REPORT_CATEGORIES).toHaveLength(10);
  });
});

describe("defaultSeverityForCategory", () => {
  it("preselects a plausible severity per category so a report is one tap fewer", () => {
    // A full closure is the most severe; congestion the least.
    expect(defaultSeverityForCategory("road_closure")).toBe(5);
    expect(defaultSeverityForCategory("accident")).toBe(4);
    expect(defaultSeverityForCategory("lane_closure")).toBe(3);
    expect(defaultSeverityForCategory("jam")).toBe(2);
    expect(defaultSeverityForCategory("other")).toBe(1);
  });

  it("returns a valid 1–5 level for every category", () => {
    for (const c of REPORT_CATEGORIES) {
      const s = defaultSeverityForCategory(c);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(5);
    }
  });
});

describe("situationForCategory", () => {
  // A report is cross-validated against official feeds by its kind and type,
  // so each category must land on the registry's vocabulary, not the dialog's.
  it.each([
    ["road_closure", { kind: "closure", type: "closure", subtype: "full" }],
    ["lane_closure", { kind: "closure", type: "closure", subtype: "lane" }],
    ["accident", { kind: "incident", type: "accident" }],
    ["stopped_vehicle", { kind: "incident", type: "breakdown", subtype: "disabled_vehicle" }],
    ["hazard_object", { kind: "incident", type: "obstruction", subtype: "object" }],
    ["hazard_weather", { kind: "weather_condition", type: "weather" }],
    ["hazard_animal", { kind: "incident", type: "obstruction", subtype: "animal" }],
    ["jam", { kind: "congestion", type: "congestion", subtype: "queuing" }],
    ["roadworks", { kind: "roadworks", type: "works" }],
    ["other", { kind: "other", type: "other" }],
  ] as const)("maps %s onto %o", (category, expected) => {
    const { kind, type, subtype } = situationForCategory(category);
    expect({ kind, type, ...(subtype === undefined ? {} : { subtype }) }).toEqual(expected);
  });

  it("closes the road for a full closure", () => {
    expect(situationForCategory("road_closure").effects).toEqual([
      { id: "closure", kind: "closure", scope: "road", ...CROWD_EFFECT_BASE },
    ]);
  });

  it("restricts some lanes for a partial closure, never a closure effect", () => {
    expect(situationForCategory("lane_closure").effects).toEqual([
      {
        id: "lanes",
        kind: "lane_restriction",
        vehicleImpact: "some_lanes_closed",
        ...CROWD_EFFECT_BASE,
      },
    ]);
  });

  it("gives a queue its level of service", () => {
    expect(situationForCategory("jam").details).toEqual({
      kind: "congestion",
      v: 1,
      los: "queuing",
    });
  });

  it("carries no effects or details for the other categories", () => {
    for (const category of REPORT_CATEGORIES) {
      if (category === "road_closure" || category === "lane_closure" || category === "jam")
        continue;
      const situation = situationForCategory(category);
      expect(situation.effects).toBeUndefined();
      expect(situation.details).toBeUndefined();
    }
  });

  it("returns fresh effect objects per call", () => {
    const first = situationForCategory("road_closure").effects;
    const second = situationForCategory("road_closure").effects;
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first?.[0]).not.toBe(second?.[0]);
  });
});

describe("generateNonce", () => {
  it("produces a 16..64 char [A-Za-z0-9_-] token", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("clamps out-of-range lengths into the valid window", () => {
    expect(generateNonce(4)).toHaveLength(16);
    expect(generateNonce(999)).toHaveLength(64);
  });
});

describe("buildReportClaim", () => {
  it("builds a Point situation claim with the mapped kind/type/fuzziness", () => {
    const claim = buildReportClaim({
      category: "accident",
      fuzziness: "ahead",
      lon: 6.1,
      lat: 51.2,
      reportedAt: "2026-07-11T10:00:00.000Z",
      nonce: "fixednonce_1234567890",
    });
    expect(claim).toEqual({
      claimClass: "situation",
      kind: "incident",
      type: "accident",
      geometry: { type: "Point", coordinates: [6.1, 51.2] },
      fuzziness: "end_unknown",
      reportedAt: "2026-07-11T10:00:00.000Z",
      nonce: "fixednonce_1234567890",
    });
  });

  it("carries the subtype, severity, effects and details of the category", () => {
    const claim = buildReportClaim({
      category: "jam",
      fuzziness: "back_of_queue",
      lon: 7,
      lat: 50,
      severityLevel: 2,
      reportedAt: "2026-07-11T10:00:00.000Z",
      nonce: "fixednonce_1234567890",
    });
    expect(claim).toEqual({
      claimClass: "situation",
      kind: "congestion",
      type: "congestion",
      subtype: "queuing",
      geometry: { type: "Point", coordinates: [7, 50] },
      fuzziness: "start_unknown",
      severityLevel: 2,
      details: { kind: "congestion", v: 1, los: "queuing" },
      reportedAt: "2026-07-11T10:00:00.000Z",
      nonce: "fixednonce_1234567890",
    });
  });

  it("builds a claim the signing client accepts for every category", () => {
    for (const category of REPORT_CATEGORIES) {
      const claim = buildReportClaim({
        category,
        fuzziness: "here",
        lon: 7,
        lat: 50,
        severityLevel: defaultSeverityForCategory(category),
        reportedAt: "2026-07-11T10:00:00.000Z",
        nonce: "fixednonce_1234567890",
      });
      expect(() => validateReportClaim(claim)).not.toThrow();
      expect(claim).not.toHaveProperty("domain");
      expect(claim).not.toHaveProperty("attributes");
    }
  });

  it("includes severityLevel only when provided", () => {
    const withSeverity = buildReportClaim({
      category: "jam",
      fuzziness: "all_along",
      lon: 0,
      lat: 0,
      severityLevel: 3,
      reportedAt: "2026-07-11T10:00:00.000Z",
      nonce: "fixednonce_1234567890",
    });
    expect(withSeverity.severityLevel).toBe(3);

    const withoutSeverity = buildReportClaim({
      category: "jam",
      fuzziness: "all_along",
      lon: 0,
      lat: 0,
      reportedAt: "2026-07-11T10:00:00.000Z",
      nonce: "fixednonce_1234567890",
    });
    expect(withoutSeverity).not.toHaveProperty("severityLevel");
  });

  it("defaults reportedAt and nonce when omitted", () => {
    const claim = buildReportClaim({ category: "other", fuzziness: "here", lon: 1, lat: 2 });
    expect(claim.nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(() => new Date(claim.reportedAt).toISOString()).not.toThrow();
    expect(claim.fuzziness).toBe("exact");
  });
});
