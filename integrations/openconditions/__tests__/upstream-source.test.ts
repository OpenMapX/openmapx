import { parseContributors } from "@openmapx/mobility-core/contributors";
import { expect, it } from "vitest";
import { NO_SOURCES, readingCredits, upstreamCredits } from "../features/record.js";

const licensing = {
  version: 1,
  bindings: [
    {
      scope: "data",
      subject: "Historical speed",
      license: { kind: "spdx", expression: "CC-BY-4.0", url: "https://historical.example/licence" },
      notice: "Historical required notice",
    },
  ],
};
const captured = {
  sourceId: "historic-native",
  attribution: {
    provider: "Historical required credit",
    name: "Historical product",
    publisher: { name: "Original authority", url: "https://authority.example/" },
    url: "https://historical.example/data",
    license: "CC-BY-4.0",
    licenseUrl: "https://historical.example/licence",
    licensing,
  },
};
const upstream = {
  publisher: "Original authority",
  license: "CC-BY-4.0",
  licensing,
  attribution: "Historical required credit",
  source: captured,
};

it("projects a historical upstream source's complete capture instead of the current feed metadata", () => {
  const results = upstreamCredits(
    [
      {
        id: "current-native",
        attribution: { provider: "Current product", url: "https://current.example/" },
        upstream: [upstream],
      },
    ],
    { ...NO_SOURCES, link: () => "https://registry.example/" },
  );
  expect(results).toEqual([
    {
      sourceId: "historic-native",
      name: "Historical product",
      url: "https://historical.example/data",
      licensing,
      publisher: { name: "Original authority", url: "https://authority.example/" },
      attributionText: "Historical required credit",
    },
  ]);
  expect(parseContributors(results)).toEqual(results);
  expect(JSON.stringify(results)).not.toContain("licenseUrl");
  captured.attribution.publisher.name = "Changed later";
  expect(results[0].publisher?.name).toBe("Original authority");
  captured.attribution.publisher.name = "Original authority";
});

it("keeps the same original capture on expanded readings and derived values", () => {
  const credits = readingCredits({
    property: "traffic.speed",
    result: {},
    phenomenonTime: {},
    source: "current-native",
    provenance: {
      sourceId: "current-native",
      attribution: { provider: "Current product", url: "https://current.example/" },
      upstream: [upstream],
    },
  });
  expect(credits).toContainEqual(
    expect.objectContaining({
      sourceId: "historic-native",
      url: "https://historical.example/data",
      licensing,
      publisher: { name: "Original authority", url: "https://authority.example/" },
    }),
  );
});

it("retains independently captured terms links as canonical evidence without inventing grants", () => {
  const [result] = upstreamCredits(
    [
      {
        id: "current",
        attribution: { provider: "Current" },
        upstream: [
          {
            ...upstream,
            source: {
              ...captured,
              attribution: {
                ...captured.attribution,
                licenseUrl: "https://historical.example/original-terms",
              },
            },
          },
        ],
      },
    ],
    NO_SOURCES,
  );
  expect(result.licensing).toEqual({
    ...licensing,
    declarations: [{ text: "CC-BY-4.0", url: "https://historical.example/original-terms" }],
  });
  expect(parseContributors([result])).toEqual([result]);
  expect(result).not.toHaveProperty("licenseUrl");
});

it("keeps an explicit captured parent identity and never substitutes the current catalogue", () => {
  const [result] = upstreamCredits(
    [
      {
        id: "current",
        attribution: { provider: "Current" },
        upstream: [
          {
            ...upstream,
            source: {
              ...captured,
              attribution: {
                ...captured.attribution,
                parentSourceId: "original-parent",
                childSourceId: captured.sourceId,
              },
            },
          },
        ],
      },
    ],
    { ...NO_SOURCES, link: () => "https://wrong-current.example/" },
  );
  expect(result.sourceId).toBe("original-parent");
  expect(result.url).toBe("https://historical.example/data");
});
