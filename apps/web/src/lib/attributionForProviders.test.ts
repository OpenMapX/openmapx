import type { IntegrationDataSource } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import { dataSourceRecordContributors } from "./attributionForProviders";

function ds(partial: Partial<IntegrationDataSource> & { sourceId: string }): IntegrationDataSource {
  return {
    name: partial.sourceId,
    url: `https://example.com/${partial.sourceId}`,
    licensing: {
      version: 1,
      bindings: [
        { scope: "data", subject: "Data", license: { kind: "spdx", expression: "ODbL-1.0" } },
      ],
    } as const,
    providerCountry: "XX",
    providerPrivacyUrl: "-",
    ...partial,
  };
}

describe("dataSourceRecordContributors", () => {
  it("retains complete per-record credits without a manifest declaration", () => {
    const receipt = {
      sourceId: "MTS-K via Tankerkönig",
      name: "MTS-K via Tankerkönig",
      url: "https://creativecommons.tankerkoenig.de/",
      licensing: {
        version: 1,
        bindings: [
          { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC-BY-4.0" } },
        ],
      } as const,
    };
    expect(
      dataSourceRecordContributors(
        { attributions: [receipt] },
        [{ sourceId: "de-mtsk", name: "MTS-K via Tankerkönig" }],
        [],
      ),
    ).toEqual([
      {
        sourceId: "MTS-K via Tankerkönig",
        name: "MTS-K via Tankerkönig",
        url: "https://creativecommons.tankerkoenig.de/",
        licensing: {
          version: 1,
          bindings: [
            { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC-BY-4.0" } },
          ],
        },
      },
    ]);
  });
  it("narrows declared manifest credits to the record and appends its legacy credits", () => {
    const credits = dataSourceRecordContributors(
      {
        source: "ocm",
        attributions: [
          { sourceId: "Ville de Paris", name: "Ville de Paris", url: "https://paris.fr" },
        ],
      },
      [{ sourceId: "ocm", name: "Open Charge Map" }],
      [ds({ sourceId: "ocm", name: "Open Charge Map" }), ds({ sourceId: "osm" })],
    );
    expect(credits.map((c) => c.name)).toEqual(["Open Charge Map", "Ville de Paris"]);
  });
  const a = { sourceId: "a", name: "A", attributionText: "Captured notice" };
  const b = { sourceId: "b", name: "B" };
  const declared = [ds({ sourceId: "a" }), ds({ sourceId: "b" })];
  it("uses captured canonical receipts independently of current declarations or envelope", () => {
    expect(dataSourceRecordContributors({ contributors: [a] }, [], declared)).toEqual([a]);
  });
  it("does not expand unknown mixed records to all declared provider sources", () => {
    expect(dataSourceRecordContributors({ source: "unknown" }, [a, b], declared)).toEqual([]);
  });
  it("narrows legacy source IDs to their captured envelope and treats explicit empty receipts as authoritative", () => {
    expect(dataSourceRecordContributors({ source: "a" }, [a, b], declared)).toEqual([a]);
    expect(
      dataSourceRecordContributors({ source: "a", contributors: [] }, [a, b], declared),
    ).toEqual([]);
  });
  it("keeps every distinct notice for exact legacy source IDs and excludes unrelated sources", () => {
    const first = { sourceId: "feed", name: "Feed", attributionText: "Required notice A" };
    const second = { sourceId: "feed", name: "Feed", attributionText: "Required notice B" };
    const envelope = [first, { sourceId: "other", name: "Other" }, second];
    expect(dataSourceRecordContributors({ source: "feed" }, envelope, [])).toEqual([first, second]);
    expect(
      dataSourceRecordContributors({ source: "feed", contributors: [] }, envelope, []),
    ).toEqual([]);
  });
});
