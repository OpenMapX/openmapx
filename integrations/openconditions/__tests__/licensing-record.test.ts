import { expect, it } from "vitest";
import {
  credit,
  NO_SOURCES,
  readingCredits,
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
