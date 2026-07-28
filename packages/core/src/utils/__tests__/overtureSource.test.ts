import { describe, expect, it } from "vitest";
import {
  assertSupportedOvertureContributors,
  normalizeOvertureProvenance,
  overtureDatasetSourceId,
} from "../overtureSource";

describe("Overture source provenance", () => {
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
