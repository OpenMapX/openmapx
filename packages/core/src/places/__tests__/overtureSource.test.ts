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

describe("Overture string, contact, and address sanitization", () => {
  it("strips control characters and bidi marks while preserving original array pointers", async () => {
    const {
      cleanOvertureString,
      selectFirstOvertureString,
      selectOvertureAddress,
      selectOvertureName,
      selectOvertureStrings,
    } = await import("../overtureSource");

    expect(cleanOvertureString("  \u200E+34 951 51 92 20\u200F ")).toBe("+34 951 51 92 20");
    expect(cleanOvertureString("\bCafe\nBerlin")).toBe("Cafe Berlin");
    expect(cleanOvertureString(" \t\u200E ")).toBeUndefined();

    expect(selectFirstOvertureString(["", "   ", "\u200E+34 951 51 92 20"], "/phones")).toEqual({
      value: "+34 951 51 92 20",
      pointer: "/phones/2",
    });
    expect(selectFirstOvertureString(["", "  "], "/emails")).toBeUndefined();

    expect(
      selectOvertureStrings(
        ["", " https://www.facebook.com/a ", "  ", "https://x.com/b"],
        "/socials",
      ),
    ).toEqual({
      values: ["https://www.facebook.com/a", "https://x.com/b"],
      pointers: ["/socials/1", "/socials/3"],
    });
    expect(selectOvertureStrings(["", "  "], "/socials")).toBeUndefined();

    expect(
      selectOvertureName(
        { primary: "\bPrimary", common: { de: "  ", en: "\u200EEnglish Name" } },
        "Fallback",
        "en-US",
      ),
    ).toEqual({
      name: "English Name",
      variants: { en: "English Name" },
      property: "/names/common/en",
    });

    expect(
      selectOvertureAddress([{ freeform: " ", locality: "", postcode: null, country: "  " }]),
    ).toEqual({ address: undefined, city: undefined, countryCode: undefined, pointers: {} });

    expect(
      selectOvertureAddress([
        {
          freeform: " Friedrichstraße 1, 10117 Berlin ",
          locality: "Berlin",
          postcode: "10117",
          country: " DE ",
        },
      ]),
    ).toEqual({
      address: "Friedrichstraße 1, 10117 Berlin",
      city: "Berlin",
      countryCode: "de",
      pointers: {
        address: ["/addresses/0/freeform"],
        city: ["/addresses/0/locality"],
        countryCode: ["/addresses/0/country"],
      },
    });
  });
});
