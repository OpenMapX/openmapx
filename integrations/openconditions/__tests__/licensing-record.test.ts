import { expect, it } from "vitest";
import {
  asModified,
  CROWD,
  credit,
  derivedShown,
  NO_SOURCES,
  readingCredits,
  recordCredits,
  sourcesOf,
  upstreamCredits,
} from "../features/record.js";

it("keeps distinct captured terms and required notices for the same upstream publisher", () => {
  const licensing = (namespace: string) => ({
    version: 1,
    bindings: [
      {
        scope: "data",
        subject: "Town data",
        license: { kind: "custom", namespace, id: "LicenseRef-Town", name: "Town terms" },
      },
    ],
  });
  const credits = upstreamCredits(
    [
      {
        id: "feed",
        attribution: { provider: "Feed" },
        upstream: [
          { publisher: "Town", attribution: "Credit A", licensing: licensing("town:a") },
          { publisher: "Town", attribution: "Credit B", licensing: licensing("town:b") },
          { publisher: "Town", attribution: "Credit A", licensing: licensing("town:a") },
        ],
      },
    ],
    NO_SOURCES,
  );
  expect(credits).toEqual([
    {
      sourceId: "feed",
      name: "Feed – Town",
      publisher: { name: "Town" },
      attributionText: "Credit A",
      licensing: licensing("town:a"),
    },
    {
      sourceId: "feed",
      name: "Feed – Town",
      publisher: { name: "Town" },
      attributionText: "Credit B",
      licensing: licensing("town:b"),
    },
  ]);
});

it("preserves different captured notices from one feed instead of collapsing its identity", () => {
  const first = {
    provider: "Notice A",
    publisher: { name: "Publisher A" },
    url: "https://example.com/a",
  };
  const second = {
    provider: "Notice B",
    publisher: { name: "Publisher B" },
    url: "https://example.com/b",
  };
  const provenance = {
    sourceId: "feed",
    attribution: first,
    mergedSources: [
      { source: "feed", recordId: "b", attribution: second },
      { source: "feed", recordId: "a", attribution: first },
    ],
  };
  const selected = sourcesOf({ provenance });
  expect(selected.map((source) => credit(source, NO_SOURCES).attributionText)).toEqual([
    "Notice A",
    "Notice B",
  ]);
  first.publisher.name = "Changed catalogue";
  expect(selected[0]?.attribution.publisher).toEqual({ name: "Publisher A" });
});

it("projects fused captures from every original supplier without crediting the synthetic fusion", () => {
  const reading = {
    source: "@fused",
    contributors: ["feed", "crowd"],
    property: "fuel.price",
    result: {},
    phenomenonTime: {},
    provenance: {
      sourceId: "@fused",
      attribution: { provider: "Synthetic winner" },
      mergedSources: [
        {
          source: "feed",
          recordId: "a",
          attribution: { provider: "Feed A", url: "https://example.com/a" },
        },
        {
          source: "feed",
          recordId: "b",
          attribution: { provider: "Feed B", url: "https://example.com/b" },
        },
        {
          source: "crowd",
          recordId: "c",
          attribution: { provider: "Captured crowd", name: "Crowd at acquisition" },
          upstream: [{ publisher: "Town", attribution: "Town notice" }],
        },
      ],
    },
  };
  const credits = readingCredits(reading);
  expect(credits.map((c) => c.attributionText)).toEqual([
    "Feed A",
    "Feed B",
    "Captured crowd",
    "Town notice",
  ]);
  expect(credits.map((c) => c.sourceId)).not.toContain("@fused");
  expect(readingCredits({ ...reading, provenance: undefined })).toEqual([]);
  expect(
    readingCredits({
      ...reading,
      provenance: { sourceId: "@fused", attribution: {}, mergedSources: [] },
    }),
  ).toEqual([]);
  reading.provenance.mergedSources[0]!.attribution.provider = "Later terms";
  expect(credits[0]?.attributionText).toBe("Feed A");
});

it("credits a record's sources as changed only where it shows a value OpenConditions derived", () => {
  const record = (over: Record<string, unknown>) => ({
    provenance: {
      sourceId: "feed",
      attribution: { name: "Feed", provider: "Feed" },
      upstream: [{ publisher: "Town" }],
    },
    location: { geometry: { type: "Point", coordinates: [7, 51] }, geometryOrigin: "source" },
    ...over,
  });
  const modified = (r: Record<string, unknown>, severity = true) =>
    recordCredits(r, { modified: derivedShown(r, { severity }) }).map((c) => c.modified);

  // The publisher's own severity, its own geometry, a fed record: presented, not changed.
  expect(modified(record({ severity: { label: "major", source: "declared" } }))).toEqual([
    undefined,
    undefined,
  ]);
  // An assessed severity changes what the shown record says; the feed and its upstream say so.
  const assessed = record({ severity: { label: "major", source: "derived" } });
  expect(modified(assessed)).toEqual([true, true]);
  // Not where the severity is not shown, nor where nothing was assessed.
  expect(modified(assessed, false)).toEqual([undefined, undefined]);
  expect(modified(record({ severity: { label: "unknown", source: "derived" } }))).toEqual([
    undefined,
    undefined,
  ]);
  // A computed record, and a redrawn area, are derived; a point standing for a shape is not.
  expect(modified(record({ provenance: { ...record({}).provenance, origin: "derived" } }))).toEqual(
    [true, true],
  );
  const area = {
    type: "Polygon",
    coordinates: [
      [
        [7, 51],
        [8, 51],
        [8, 52],
        [7, 51],
      ],
    ],
  };
  expect(
    modified(record({ location: { geometry: area, geometryOrigin: "derived" } }), false),
  ).toEqual([true, true]);
  expect(
    modified(
      record({
        location: { geometry: { type: "Point", coordinates: [7, 51] }, geometryOrigin: "derived" },
      }),
      false,
    ),
  ).toEqual([undefined, undefined]);
});

it("never marks the instance's own crowd reports, nor a credit built on its own, as changed", () => {
  expect(
    credit({ id: "feed", attribution: { name: "Feed" }, upstream: [] }, NO_SOURCES),
  ).not.toHaveProperty("modified");
  const [crowd] = asModified([{ sourceId: CROWD, name: "Contributors" }]);
  expect(crowd).not.toHaveProperty("modified");
  expect(asModified([{ sourceId: "feed", name: "Feed" }])[0]!.modified).toBe(true);
});
