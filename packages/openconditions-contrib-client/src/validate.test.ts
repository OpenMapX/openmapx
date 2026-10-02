import { describe, expect, it } from "vitest";
import type { ReportClaim, SituationClaim, SubClaimBody } from "./types.js";
import { validateReportClaim, validateSubClaimBody } from "./validate.js";

const SITUATION: SituationClaim = {
  claimClass: "situation",
  kind: "closure",
  type: "closure",
  subtype: "full",
  geometry: { type: "Point", coordinates: [7.0982, 50.7374] },
  fuzziness: "exact",
  severityLevel: 4,
  effects: [
    {
      id: "closure",
      kind: "closure",
      v: 1,
      scope: "road",
      applicability: { kind: "all" },
      compliance: "mandatory",
      normalization: "complete",
    },
  ],
  reportedAt: "2026-07-11T12:34:56Z",
  nonce: "validate-nonce-000001",
};

const VOTE: SubClaimBody = {
  subject: { class: "situation", id: "crowd:situation-0001" },
  claimType: "confirm",
  reportedAt: "2026-07-11T12:35:00Z",
  nonce: "subclaim-nonce-000001",
};

const claim = (patch: Record<string, unknown>) => ({ ...SITUATION, ...patch }) as ReportClaim;
const vote = (patch: Record<string, unknown>) => ({ ...VOTE, ...patch }) as SubClaimBody;

describe("validateReportClaim", () => {
  it("accepts a situation claim with effects, details and text", () => {
    expect(() =>
      validateReportClaim(
        claim({
          details: { kind: "congestion", v: 1, los: "queuing" },
          text: [{ lang: "de", text: "Stau", machine: true }],
        }),
      ),
    ).not.toThrow();
  });

  it("accepts an observation claim about a feature", () => {
    expect(() =>
      validateReportClaim({
        claimClass: "observation",
        subject: { featureId: "osm:way/1", componentKey: "lane:1" },
        property: "surface",
        result: { value: "gravel" },
        geometry: { type: "Point", coordinates: [7.1, 50.7] },
        reportedAt: "2026-07-11T12:34:56Z",
        nonce: "validate-nonce-000002",
      }),
    ).not.toThrow();
  });

  it("rejects an unknown claim class", () => {
    expect(() => validateReportClaim(claim({ claimClass: "report" }))).toThrow(/claimClass/);
  });

  it("rejects keys a situation claim does not carry", () => {
    expect(() => validateReportClaim(claim({ domain: "roads" }))).toThrow(/"domain"/);
    expect(() => validateReportClaim(claim({ attributes: {} }))).toThrow(/"attributes"/);
  });

  it("rejects an empty kind, type or subtype", () => {
    expect(() => validateReportClaim(claim({ kind: "" }))).toThrow(/claim\.kind/);
    expect(() => validateReportClaim(claim({ type: "" }))).toThrow(/claim\.type/);
    expect(() => validateReportClaim(claim({ subtype: "" }))).toThrow(/claim\.subtype/);
  });

  it("rejects a severity level outside 1..5", () => {
    expect(() => validateReportClaim(claim({ severityLevel: 6 }))).toThrow(/severityLevel/);
  });

  it("rejects empty effects, repeated effect ids and missing common effect fields", () => {
    const effect = SITUATION.effects?.[0];
    expect(() => validateReportClaim(claim({ effects: [] }))).toThrow(/effects/);
    expect(() => validateReportClaim(claim({ effects: [effect, effect] }))).toThrow(/repeats/);
    expect(() =>
      validateReportClaim(claim({ effects: [{ ...effect, compliance: undefined }] })),
    ).toThrow(/compliance/);
    expect(() =>
      validateReportClaim(claim({ effects: [{ ...effect, applicability: { kind: "some" } }] })),
    ).toThrow(/applicability/);
  });

  it("rejects non-object details and malformed text", () => {
    expect(() => validateReportClaim(claim({ details: [] }))).toThrow(/details/);
    expect(() => validateReportClaim(claim({ text: [] }))).toThrow(/text/);
    expect(() => validateReportClaim(claim({ text: [{ lang: "de", text: "" }] }))).toThrow(
      /text\[0\]\.text/,
    );
    expect(() =>
      validateReportClaim(claim({ text: [{ lang: "de", text: "x", machine: false }] })),
    ).toThrow(/machine/);
  });

  it("keeps the nonce, instant and I-JSON rules", () => {
    expect(() => validateReportClaim(claim({ nonce: "short" }))).toThrow(/nonce/);
    expect(() => validateReportClaim(claim({ reportedAt: "2026-07-11T12:00:00" }))).toThrow(
      /zone designator/,
    );
    expect(() => validateReportClaim(claim({ details: { x: Number.NaN } }))).toThrow(/non-finite/);
  });
});

describe("validateSubClaimBody", () => {
  it("accepts a record reference, including a feature component", () => {
    expect(() => validateSubClaimBody(VOTE)).not.toThrow();
    expect(() =>
      validateSubClaimBody(
        vote({ subject: { class: "feature", id: "osm:way/1", componentKey: "lane:1" } }),
      ),
    ).not.toThrow();
  });

  it("rejects a string subject and unknown record classes", () => {
    expect(() => validateSubClaimBody(vote({ subject: "urn:openconditions:report:x" }))).toThrow(
      /subject must be an object/,
    );
    expect(() => validateSubClaimBody(vote({ subject: { class: "report", id: "x" } }))).toThrow(
      /subject\.class/,
    );
  });

  it("allows a component only on a feature", () => {
    expect(() =>
      validateSubClaimBody(vote({ subject: { class: "situation", id: "x", componentKey: "k" } })),
    ).toThrow(/only allowed on a feature/);
  });

  it("requires a Point geometry and rejects envelope and unknown fields", () => {
    expect(() =>
      validateSubClaimBody(
        vote({
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
        }),
      ),
    ).toThrow(/Point/);
    expect(() => validateSubClaimBody(vote({ signature: "x" }))).toThrow(/envelope field/);
    expect(() => validateSubClaimBody(vote({ extra: 1 }))).toThrow(/"extra"/);
  });
});
