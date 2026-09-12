import { describe, expect, it } from "vitest";
import {
  hasRoadRestrictionEvidence,
  readRoadRestrictionDetails,
} from "../utils/roadRestrictionDetails";

/**
 * Host-side wire validation. The fixture is a published envelope with the
 * producer's evaluation metadata, not source JSON: the browser never sees the
 * upstream field names and never derives temporal state itself.
 */
function published(): Record<string, unknown> {
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
      modificationNotice:
        "Normalized by OpenConditions; source units and structure may be transformed.",
    },
    facts: [
      {
        id: "GUID50465935:GUID50469933:roadwork_phase:restrictions[2]",
        kind: "dimension",
        dimension: "gross_weight",
        meaning: "maximum_permitted",
        value: 26000,
        unit: "kg",
        operator: "lte",
        state: "active",
        scope: {
          kind: "roadwork_phase",
          phaseId: "GUID50469933",
          locationDescription: "Tie 104, Raasepori",
          sourceLocationRefs: { scheme: "digitraffic_road_address", road: 104 },
          restrictionBinding: "not_established",
        },
        direction: { basis: "road_reference", value: "both", description: null },
        validFrom: "2026-07-19T21:00:00.000Z",
        validTo: "2026-12-14T21:59:59.999Z",
        sourceTokens: { type: "vehicle gross weight limit", quantity: 26, unit: "t" },
        context: {
          restrictionsLiftable: false,
          compliance: "unknown",
          operatorActionStatus: null,
          validityStatus: null,
        },
      },
    ],
    evaluatedAt: "2026-09-12T07:14:00.000Z",
    sourceCheckedAt: "2026-09-12T07:13:00.000Z",
    freshUntil: "2026-09-12T07:23:00.000Z",
    nextTransitionAt: "2026-12-14T21:59:59.999Z",
    isStale: false,
  };
}

describe("readRoadRestrictionDetails", () => {
  it("accepts a valid published envelope verbatim", () => {
    const details = published();
    const read = readRoadRestrictionDetails({ restrictionDetails: details });
    expect(read.restrictionDetails).toBe(details);
    expect(read.restrictionDetailsUnsupported).toBeUndefined();
  });

  it("marks an unknown version, a null envelope and a bare string unsupported", () => {
    for (const value of [{ schemaVersion: 2 }, null, "details", 1, []]) {
      expect(readRoadRestrictionDetails({ restrictionDetails: value })).toEqual({
        restrictionDetailsUnsupported: true,
      });
    }
  });

  it("rejects an envelope whose evaluation metadata is missing", () => {
    const withoutState = published();
    delete (withoutState.facts as Array<Record<string, unknown>>)[0]!.state;
    expect(readRoadRestrictionDetails({ restrictionDetails: withoutState })).toEqual({
      restrictionDetailsUnsupported: true,
    });

    const withoutEvaluatedAt = published();
    delete withoutEvaluatedAt.evaluatedAt;
    expect(readRoadRestrictionDetails({ restrictionDetails: withoutEvaluatedAt })).toEqual({
      restrictionDetailsUnsupported: true,
    });
  });

  it("rejects an invalid numeric value rather than displaying it as verified", () => {
    for (const value of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, "26000"]) {
      const details = published();
      Object.assign((details.facts as Array<Record<string, unknown>>)[0]!, { value });
      expect(readRoadRestrictionDetails({ restrictionDetails: details })).toEqual({
        restrictionDetailsUnsupported: true,
      });
    }
  });

  it("rejects a unit that contradicts its dimension and a mislabelled maximum", () => {
    const wrongUnit = published();
    Object.assign((wrongUnit.facts as Array<Record<string, unknown>>)[0]!, { unit: "m" });
    expect(readRoadRestrictionDetails({ restrictionDetails: wrongUnit })).toEqual({
      restrictionDetailsUnsupported: true,
    });

    const notAMaximum = published();
    Object.assign((notAMaximum.facts as Array<Record<string, unknown>>)[0]!, { operator: "gt" });
    expect(readRoadRestrictionDetails({ restrictionDetails: notAMaximum })).toEqual({
      restrictionDetailsUnsupported: true,
    });
  });

  it("accepts a greater-than predicate that does not claim to be a maximum", () => {
    const predicate = published();
    Object.assign((predicate.facts as Array<Record<string, unknown>>)[0]!, {
      dimension: "height",
      unit: "m",
      value: 4.5,
      operator: "gt",
      meaning: "event_applies_when",
    });
    expect(readRoadRestrictionDetails({ restrictionDetails: predicate })).toMatchObject({
      restrictionDetails: { completeness: "complete" },
    });
  });

  it("rejects an empty fact list unless it is declared partial evidence", () => {
    const emptyComplete = { ...published(), facts: [] };
    expect(readRoadRestrictionDetails({ restrictionDetails: emptyComplete })).toEqual({
      restrictionDetailsUnsupported: true,
    });

    const emptyPartial = {
      ...published(),
      facts: [],
      vehicleScope: "unknown",
      completeness: "partial",
      issues: [{ code: "unsupported_type", factId: null, sourcePath: "restrictions[0]" }],
    };
    expect(readRoadRestrictionDetails({ restrictionDetails: emptyPartial })).toMatchObject({
      restrictionDetails: { completeness: "partial" },
    });
  });

  it("rejects an issue code outside the closed set", () => {
    const details = {
      ...published(),
      issues: [{ code: "made_up", factId: null, sourcePath: "x" }],
    };
    expect(readRoadRestrictionDetails({ restrictionDetails: details })).toEqual({
      restrictionDetailsUnsupported: true,
    });
  });

  it("requires the source rights the display has to show", () => {
    for (const patch of [
      { licenseUrl: "javascript:alert(1)" },
      { feedUrls: ["not-a-url"] },
      { attribution: "" },
      { modificationNotice: "" },
    ]) {
      const details = published();
      Object.assign(details.source as Record<string, unknown>, patch);
      expect(readRoadRestrictionDetails({ restrictionDetails: details })).toEqual({
        restrictionDetailsUnsupported: true,
      });
    }
  });

  it("keeps a present-but-undefined envelope as an explicit claim", () => {
    expect(readRoadRestrictionDetails({ restrictionDetails: undefined })).toEqual({
      restrictionDetailsUnsupported: true,
    });
  });

  it("preserves a supplied unsupported marker and reports absence as absence", () => {
    expect(readRoadRestrictionDetails({ restrictionDetailsUnsupported: true })).toEqual({
      restrictionDetailsUnsupported: true,
    });
    expect(readRoadRestrictionDetails({})).toEqual({});
    expect(readRoadRestrictionDetails({ restrictionDetailsUnsupported: false })).toEqual({});
  });
});

describe("hasRoadRestrictionEvidence", () => {
  it("treats valid details, an unsupported marker and neither distinctly", () => {
    expect(
      hasRoadRestrictionEvidence(
        readRoadRestrictionDetails({ restrictionDetails: published() }) as never,
      ),
    ).toBe(true);
    expect(hasRoadRestrictionEvidence({ restrictionDetailsUnsupported: true })).toBe(true);
    expect(hasRoadRestrictionEvidence({})).toBe(false);
  });
});
