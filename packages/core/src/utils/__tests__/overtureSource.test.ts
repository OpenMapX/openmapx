import { describe, expect, it } from "vitest";
import {
  assertSupportedOvertureContributors,
  normalizeOvertureProvenance,
  overtureDatasetSourceId,
} from "../overtureSource";

describe("Overture source provenance", () => {
  it.each(["constructor", "Constructor", "con-structor"])(
    "rejects inherited object members as contributor datasets: %s",
    (dataset) => {
      expect(() => overtureDatasetSourceId(dataset)).toThrow(/Unsupported Overture/);
      expect(() => assertSupportedOvertureContributors(["Meta", dataset])).toThrow(
        /unsupported contributor dataset/,
      );
      expect(() => normalizeOvertureProvenance([{ dataset }])).toThrow(/Unsupported Overture/);
    },
  );

  it("maps current dataset names to attribution ids", () => {
    expect(overtureDatasetSourceId("Foursquare")).toBe("foursquare");
    expect(overtureDatasetSourceId("meta")).toBe("meta-places");
    expect(overtureDatasetSourceId("AllThePlaces")).toBe("alltheplaces");
    expect(overtureDatasetSourceId("Overture")).toBe("overture");
    expect(() => overtureDatasetSourceId("A future contributor")).toThrow(
      /Add its required attribution/,
    );
  });

  it("rejects release activation when any contributor is unsupported", () => {
    expect(() =>
      assertSupportedOvertureContributors(["Meta", "Foursquare", "A future contributor"]),
    ).toThrow(/unsupported contributor dataset\(s\): A future contributor/);
    expect(() =>
      assertSupportedOvertureContributors([
        "Meta",
        "Microsoft",
        "Overture",
        "PinMeTo",
        "Krick",
        "RenderSEO",
        "DAC",
        "BrightQuery",
        "Foursquare",
        "AllThePlaces",
      ]),
    ).not.toThrow();
  });

  it("keeps property-level record lineage and the release", () => {
    expect(
      normalizeOvertureProvenance(
        [
          {
            property: "/phones/0",
            dataset: "Foursquare",
            record_id: "fsq-1",
            update_time: "2026-03-18T00:00:00Z",
            license: "Apache-2.0",
          },
        ],
        "2026-07-22.0",
      ),
    ).toEqual([
      {
        sourceId: "overture",
        dataset: "Overture Maps",
        release: "2026-07-22.0",
      },
      {
        sourceId: "foursquare",
        dataset: "Foursquare",
        property: "/phones/0",
        recordId: "fsq-1",
        updatedAt: "2026-03-18T00:00:00Z",
        license: "Apache-2.0",
        release: "2026-07-22.0",
      },
    ]);
  });
});

it("selects the most specific Overture property supplier without unrelated root notices", async () => {
  const { overturePropertyContributors } = await import("../overtureSource");
  const receipt = (sourceId: string) => ({ sourceId, name: sourceId });
  const sources = [
    { property: "", dataset: "Meta" },
    { property: "/names", dataset: "Microsoft" },
    { property: "/names/common/de", dataset: "Foursquare" },
    { property: "/phones/0", dataset: "BrightQuery" },
  ];
  const catalogue = [
    "overture",
    "meta-places",
    "microsoft-places",
    "foursquare",
    "brightquery",
  ].map(receipt);
  expect(overturePropertyContributors(sources, catalogue, ["/geometry"])).toEqual([
    receipt("overture"),
    receipt("meta-places"),
  ]);
  expect(overturePropertyContributors(sources, catalogue, ["/names/common/de"])).toEqual([
    receipt("overture"),
    receipt("foursquare"),
  ]);
  expect(overturePropertyContributors(sources, catalogue, ["/names/primary"])).toEqual([
    receipt("overture"),
    receipt("microsoft-places"),
  ]);
  expect(
    overturePropertyContributors(sources, catalogue, ["/names/common/de", "/phones/0"]),
  ).toEqual([receipt("overture"), receipt("foursquare"), receipt("brightquery")]);
  expect(overturePropertyContributors(sources, catalogue, [])).toEqual([]);
  expect(
    overturePropertyContributors([{ property: "/names", dataset: "Meta" }], catalogue, [
      "/geometry",
    ]),
  ).toEqual([receipt("overture")]);
});
