import { describe, expect, it } from "vitest";
import {
  contributorKey,
  contributorsForFields,
  contributorsForRecords,
  narrowContributors,
  parseContributors,
  parseFieldContributors,
  serializeContributors,
  snapshotContributors,
  withContributors,
  withFeatureContributors,
} from "./contributors.js";
import type { Attribution } from "./types/attribution.js";

const a: Attribution = {
  sourceId: "a",
  name: "A",
  url: "https://a.example",
  publisher: { name: "Publisher", url: "https://publisher.example" },
};
const b: Attribution = { sourceId: "b", name: "B", spdxLicense: "CC-BY-4.0" };

describe("canonical contributor snapshots", () => {
  it("copies metadata so cached records do not follow later input mutation", () => {
    const input = structuredClone(a);
    const record = withContributors({ id: "record" }, [input]);
    input.name = "changed";
    if (input.publisher) input.publisher.name = "changed publisher";
    expect(record.contributors).toEqual([a]);
    expect(record).toMatchObject({ id: "record" });
  });
  it("retains distinct required notices of the same source and deduplicates identical receipts", () => {
    const notice = { sourceId: "a", name: "Required notice" };
    expect(snapshotContributors([a, notice], [a, b])).toEqual([a, notice, b]);
    expect(contributorKey(a)).not.toBe(contributorKey(notice));
    expect(contributorKey(a)).toBe(contributorKey({ ...a, retrievedAt: "later" }));
  });
  it("unions only retained displayed records, keeping explicit empty receipts empty", () => {
    expect(
      contributorsForRecords([
        { contributors: [a] },
        { contributors: [] },
        null,
        { contributors: [a, b] },
      ]),
    ).toEqual([a, b]);
    expect(contributorsForRecords([{ contributors: [] }, {}])).toEqual([]);
  });
  it("unions high-cardinality result streams without spreading records into call arguments", () => {
    const records = Array.from({ length: 140_000 }, () => ({ contributors: [a] }));
    expect(contributorsForRecords(records)).toEqual([a]);
  });
  it("does not expand an unmatched exact-source request", () => {
    expect(narrowContributors([a, b], ["missing"])).toEqual([]);
    expect(narrowContributors([a, b], ["b"])).toEqual([b]);
  });
  it("distinguishes absent or invalid receipts from authoritative empty receipts", () => {
    expect(parseContributors(undefined)).toBeUndefined();
    expect(parseContributors("not json")).toBeUndefined();
    expect(parseContributors([{ sourceId: "bad", name: 42 }])).toBeUndefined();
    expect(parseContributors([])).toEqual([]);
    expect(parseContributors("[]")).toEqual([]);
  });
  it("roundtrips all canonical metadata and strips unknown object fields", () => {
    expect(parseContributors(serializeContributors([a, b]))).toEqual([a, b]);
    expect(parseContributors([{ ...a, privateCredential: "must not copy" }])).toEqual([a]);
  });
  it("captures GeoJSON credit properties without mutating the source feature", () => {
    const feature = {
      type: "Feature" as const,
      properties: { id: "line" },
      geometry: {
        type: "LineString" as const,
        coordinates: [
          [6, 51],
          [7, 51],
        ],
      },
    };
    const captured = withFeatureContributors(feature, [a, b]);
    expect(feature.properties).toEqual({ id: "line" });
    expect(captured.geometry).toBe(feature.geometry);
    expect(parseContributors(captured.properties._mapAttributions)).toEqual([a, b]);
  });
});

describe("field contributor snapshots", () => {
  it("parses portable field maps without inventing invalid field receipts", () => {
    const map = { geometry: [a], ratio: [a, b], los: [], speed: "invalid" };
    expect(parseFieldContributors(JSON.stringify(map))).toEqual({
      geometry: [a],
      ratio: [a, b],
      los: [],
    });
    expect(parseFieldContributors("not json")).toBeUndefined();
    expect(parseFieldContributors([])).toBeUndefined();
  });
  it("projects only actually displayed fields and preserves authoritative empty", () => {
    expect(
      contributorsForFields({ geometry: [a], ratio: [a], los: [b] }, ["geometry", "ratio"]),
    ).toEqual([a]);
    expect(contributorsForFields({ geometry: [a], ratio: [], los: [b] }, ["ratio"])).toEqual([]);
    expect(contributorsForFields(undefined, ["ratio"])).toEqual([]);
  });
});
