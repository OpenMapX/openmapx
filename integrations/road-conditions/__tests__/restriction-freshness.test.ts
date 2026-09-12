import type { RoadConditionEvent } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import {
  hasRestrictionView,
  RESTRICTION_VIEW_MAX_AGE_MS,
  restrictionRefreshDeadline,
} from "../restriction-freshness";

/**
 * The browser consumes the producer's deadlines; it never invents one. These
 * cases pin the two directions that matter: a trustworthy view is refreshed at
 * the producer's instant, and an untrustworthy one is refreshed immediately
 * rather than shown with a verified-current label.
 */

const NOW = Date.parse("2026-09-12T07:14:00.000Z");

function view(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    vehicleScope: "specific",
    completeness: "complete",
    issues: [],
    source: {
      sourceId: "fi-digitraffic",
      recordId: "GUID50465935",
      recordVersion: "31",
      sourceUpdatedAt: "2026-08-28T04:18:02.629Z",
      feedUrls: ["https://tie.digitraffic.fi/api/traffic-message/v2/roadworks"],
      publisher: "Fintraffic / Digitraffic",
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      attribution: "Fintraffic / Digitraffic",
      modificationNotice: "Normalized by OpenConditions",
    },
    facts: [],
    evaluatedAt: "2026-09-12T07:14:00.000Z",
    sourceCheckedAt: "2026-09-12T07:13:00.000Z",
    freshUntil: "2026-09-12T07:23:00.000Z",
    nextTransitionAt: null,
    isStale: false,
    ...over,
  } as unknown as NonNullable<RoadConditionEvent["restrictionDetails"]>;
}

function event(over: Partial<RoadConditionEvent> = {}): RoadConditionEvent {
  return {
    id: "fi-digitraffic:GUID50465935",
    source: "fi-digitraffic",
    provider: "road-conditions-openconditions",
    type: "restriction",
    severity: "high",
    geometry: { type: "Point", coordinates: [23.5, 60.1] },
    headline: "Tie 104",
    restrictionDetails: view(),
    ...over,
  };
}

describe("restrictionRefreshDeadline", () => {
  it("caps a distant deadline at one minute", () => {
    expect(restrictionRefreshDeadline([event()], NOW)).toBe(NOW + RESTRICTION_VIEW_MAX_AGE_MS);
  });

  it("shortens to an imminent freshness deadline", () => {
    const deadline = restrictionRefreshDeadline(
      [event({ restrictionDetails: view({ freshUntil: "2026-09-12T07:14:20.000Z" }) })],
      NOW,
    );
    expect(deadline).toBe(Date.parse("2026-09-12T07:14:20.000Z"));
  });

  it("shortens to an imminent phase transition", () => {
    const deadline = restrictionRefreshDeadline(
      [event({ restrictionDetails: view({ nextTransitionAt: "2026-09-12T07:14:05.000Z" }) })],
      NOW,
    );
    expect(deadline).toBe(Date.parse("2026-09-12T07:14:05.000Z"));
  });

  it("takes the earliest deadline across the visible collection", () => {
    const deadline = restrictionRefreshDeadline(
      [
        event({ id: "a" }),
        event({
          id: "b",
          restrictionDetails: view({ nextTransitionAt: "2026-09-12T07:14:10.000Z" }),
        }),
      ],
      NOW,
    );
    expect(deadline).toBe(Date.parse("2026-09-12T07:14:10.000Z"));
  });

  it("refuses to wait for a stale, freshness-less, elapsed or unparseable view", () => {
    for (const over of [
      { isStale: true },
      { freshUntil: null },
      { freshUntil: "2026-09-12T07:13:59.000Z" },
      { freshUntil: "not a time" },
    ]) {
      expect(
        restrictionRefreshDeadline([event({ restrictionDetails: view(over) })], NOW),
        JSON.stringify(over),
      ).toBe(NOW);
    }
  });

  it("refuses to wait when any visible envelope is unsupported", () => {
    expect(
      restrictionRefreshDeadline(
        [
          event(),
          event({ id: "bad", restrictionDetails: undefined, restrictionDetailsUnsupported: true }),
        ],
        NOW,
      ),
    ).toBe(NOW);
  });

  it("keeps the default ceiling when nothing carries a restriction view", () => {
    expect(restrictionRefreshDeadline([event({ restrictionDetails: undefined })], NOW)).toBe(
      NOW + RESTRICTION_VIEW_MAX_AGE_MS,
    );
    expect(restrictionRefreshDeadline([], NOW)).toBe(NOW + RESTRICTION_VIEW_MAX_AGE_MS);
  });

  it("returns its input for an unusable instant instead of inventing one", () => {
    expect(restrictionRefreshDeadline([event()], Number.NaN)).toBeNaN();
  });
});

describe("hasRestrictionView", () => {
  it("counts valid details and an unsupported marker, but not absence", () => {
    expect(hasRestrictionView([event()])).toBe(true);
    expect(
      hasRestrictionView([
        event({ restrictionDetails: undefined, restrictionDetailsUnsupported: true }),
      ]),
    ).toBe(true);
    expect(hasRestrictionView([event({ restrictionDetails: undefined })])).toBe(false);
    expect(hasRestrictionView([])).toBe(false);
  });
});
