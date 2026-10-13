import { describe, expect, it } from "vitest";
import {
  captureResultContributors,
  contributorKey,
  contributorsForField,
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
const b: Attribution = {
  sourceId: "b",
  name: "B",
  licensing: {
    version: 1,
    bindings: [
      { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC-BY-4.0" } },
    ],
  } as const,
};

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
    expect(parseFieldContributors(JSON.stringify(map))).toBeUndefined();
    delete (map as Partial<typeof map>).speed;
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

it("captures exact envelope sources including distinct notices and explicit emptiness", () => {
  const notice = { ...a, attributionText: "Required second notice" };
  expect(captureResultContributors({ sourceIds: [a.sourceId] }, [a, b, notice])).toEqual([
    a,
    notice,
  ]);
  expect(captureResultContributors({ contributors: [], sourceIds: [a.sourceId] }, [a])).toEqual([]);
  expect(captureResultContributors({}, [a, b])).toEqual([]);
  expect(captureResultContributors({}, [a, notice])).toEqual([a, notice]);
});

it("projects certified containers while an explicit empty child and missing mixed field stay authoritative", () => {
  const record = {
    contributors: [a, b],
    fieldContributors: { osmTags: [a], "osmTags.hidden": [] },
  };
  expect(contributorsForField(record, "osmTags.visible")).toEqual([a]);
  expect(contributorsForField(record, "osmTags.hidden")).toEqual([]);
  expect(contributorsForField(record, "description")).toEqual([]);
});

it("projects displayed record fields through exact and certified container receipts", async () => {
  const { contributorsForRecordFields } = await import("./contributors.js");
  const a = { sourceId: "a", name: "A" };
  const b = { sourceId: "b", name: "B" };
  expect(contributorsForRecordFields({ contributors: [a] }, ["geometry", "name"])).toEqual([a]);
  expect(
    contributorsForRecordFields(
      {
        contributors: [a, b],
        fieldContributors: {
          geometry: [a],
          tags: [b],
          "tags.hidden": [],
        },
      },
      ["geometry", "tags.name", "tags.hidden", "unknown"],
    ),
  ).toEqual([a, b]);
});

it("copies nested receipts when a field is renamed without widening missing ownership", async () => {
  const { captureFieldContributors } = await import("./contributors.js");
  const a = { sourceId: "a", name: "Original" };
  const copied = captureFieldContributors(
    { contributors: [a], fieldContributors: { "names.de": [a], "names.en": [] } },
    "names",
    "labels",
  );
  expect(copied).toEqual({ labels: [], "labels.de": [a], "labels.en": [] });
  a.name = "Changed";
  expect(copied["labels.de"]?.[0].name).toBe("Original");
});

it("converts only trusted static credit metadata without carrying provider controls", async () => {
  const { dataSourceToAttribution } = await import("./contributors.js");
  const raw = {
    sourceId: "a",
    name: "A",
    url: "https://example.test",
    licensing: {
      version: 1,
      bindings: [
        { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC0-1.0" } },
      ],
    } as const,
    attribution: "Original notice",
    providerCountry: "DE",
    endUserExposure: "server-only",
    commercialUse: "yes",
  };
  const captured = dataSourceToAttribution(raw);
  expect(captured).toEqual({
    sourceId: "a",
    name: "A",
    url: "https://example.test",
    licensing: {
      version: 1,
      bindings: [
        { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC0-1.0" } },
      ],
    } as const,
    attributionText: "Original notice",
  });
  raw.attribution = "Changed";
  expect(captured.attributionText).toBe("Original notice");
});

it("captures independent field receipts when attaching a record receipt at acquisition", () => {
  const field = { sourceId: "field", name: "Original field" };
  const parent = { sourceId: "parent", name: "Parent" };
  const captured = withContributors(
    { name: "Row", fieldContributors: { name: [field], hidden: [] } },
    [parent],
  );
  field.name = "Changed";
  expect(captured.fieldContributors.name[0].name).toBe("Original field");
  expect(captured.fieldContributors.hidden).toEqual([]);
});

it("resolves nested displayed fields from the closest canonical child with indexed legacy fallback", async () => {
  const { contributorsForNestedRecordFields } = await import("./contributors.js");
  const root = {
    contributors: [a],
    fieldContributors: { legs: [a], "legs.0.steps.1.instruction": [b] },
  };
  const legacy = [
    { field: "legs.0", record: {} },
    { field: "steps.1", record: {} },
  ];
  expect(contributorsForNestedRecordFields(root, legacy, ["instruction"])).toEqual([b]);
  expect(
    contributorsForNestedRecordFields(
      root,
      [{ field: "legs.0", record: { contributors: [] } }, legacy[1]],
      ["instruction"],
    ),
  ).toEqual([]);
  expect(
    contributorsForNestedRecordFields(
      root,
      [{ field: "legs.0", record: { fieldContributors: {} } }, legacy[1]],
      ["instruction"],
    ),
  ).toEqual([]);
  expect(
    contributorsForNestedRecordFields(
      root,
      [
        { field: "legs.0", record: { contributors: [] } },
        { field: "steps.1", record: { contributors: [b] } },
      ],
      ["instruction"],
    ),
  ).toEqual([b]);
});
