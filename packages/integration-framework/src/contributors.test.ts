import { sanitizeAttributionHtml } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { describe, expect, it } from "vitest";
import {
  captureFieldContributors,
  captureIntegrationContributorCatalogue,
  contributorsForRecordFields,
  parseContributors,
  parseFieldContributors,
  resolveCapturedContributors,
  resolveContributors,
  resolveSourceContributors,
  snapshotContributors,
} from "./contributors";

const a: Attribution = { sourceId: "a", name: "A", publisher: { name: "Original" } };
const resolver = (id: string) => (id === "a" ? a : undefined);

describe("exact contributor resolution", () => {
  it("resolves only explicitly named identities and copies metadata", () => {
    const result = resolveSourceContributors(["unknown", "a", "a"], resolver);
    expect(result).toEqual([a]);
    expect(result[0]).not.toBe(a);
    expect(result[0].publisher).not.toBe(a.publisher);
    expect(resolveSourceContributors(["unknown"], resolver)).toEqual([]);
  });
  it("prefers an authoritative snapshot including empty over current catalogue metadata", () => {
    const captured = { sourceId: "a", name: "Captured notice" };
    expect(resolveContributors({ contributors: [captured], sourceIds: ["a"] }, resolver)).toEqual([
      captured,
    ]);
    expect(resolveContributors({ contributors: [], sourceIds: ["a"] }, resolver)).toEqual([]);
  });
  it("uses explicit acquisition source identities only when the receipt is absent", () => {
    expect(resolveContributors({ sourceIds: ["a", "missing"] }, resolver)).toEqual([a]);
    expect(resolveContributors({ contributors: "bad", sourceIds: ["a"] }, resolver)).toEqual([]);
    expect(resolveContributors({}, resolver)).toEqual([]);
  });
});

describe("portable companion contributor contract", () => {
  it("never treats a multi-supplier manifest as evidence for an untagged community record", () => {
    const catalogue = {
      declaredByIntegration: new Map([
        [
          "community-adapter",
          [
            { sourceId: "a", name: "A" },
            { sourceId: "b", name: "B" },
          ],
        ],
      ]),
      runtimeById: new Map(),
      hasRuntime: false,
    };
    expect(resolveCapturedContributors(catalogue, "community-adapter", {})).toEqual([]);
    expect(resolveCapturedContributors(catalogue, "community-adapter", {}, true)).toEqual([]);
    expect(
      resolveCapturedContributors(catalogue, "community-adapter", { sourceIds: ["unknown-child"] }),
    ).toEqual([]);
    expect(
      resolveCapturedContributors(catalogue, "community-adapter", { sourceIds: ["a"] }),
    ).toEqual([{ sourceId: "a", name: "A" }]);
  });
  it.each([
    '[{"sourceId":"feed","name":23}]',
    [{ sourceId: "feed", name: "Feed", publisher: { url: "https://example.com" } }],
    [{ sourceId: "feed", name: "Feed", licenseUrl: 23 }],
    [{ sourceId: "feed", name: "Feed" }, null],
  ])("rejects malformed receipts without inventing a catalogue supplier: %j", (payload) => {
    expect(parseContributors(payload)).toBeUndefined();
    expect(
      resolveContributors({ contributors: payload, sourceIds: ["unknown"] }, resolver),
    ).toEqual([]);
  });

  it.each([[], "[]"])(
    "keeps canonical empty receipts authoritative over explicit legacy IDs: %j",
    (payload) => {
      expect(resolveContributors({ contributors: payload, sourceIds: ["a"] }, resolver)).toEqual(
        [],
      );
    },
  );

  it("validates portable metadata without accepting executable capability fields", () => {
    const parsed = parseContributors([
      {
        sourceId: "community-feed",
        name: "Community feed",
        publisher: { name: "Publisher" },
        resolveCustomContributors: "execute me",
        complementaryGradientGroups: [["a", "b"]],
      },
    ]);
    expect(parsed).toEqual([
      { sourceId: "community-feed", name: "Community feed", publisher: { name: "Publisher" } },
    ]);
  });

  it("preserves required wording while rebuilding only safe attribution markup", () => {
    const receipts = parseContributors(
      String.raw`[{"sourceId":"community-feed","name":"Feed","attributionText":"© <a href=\"https://publisher.example/\" onclick=\"run()\">Publisher</a> <img src=x onerror=run()> &amp; <a href=\"javascript:run()\">contributors</a>"}]`,
    );
    expect(receipts).toBeDefined();
    expect(sanitizeAttributionHtml(receipts?.[0].attributionText ?? "")).toBe(
      '© <a href="https://publisher.example/" target="_blank" rel="noopener noreferrer">Publisher</a>  &amp; contributors',
    );
  });

  it("projects field/container ownership while an explicit empty child blocks broader receipts", () => {
    const captured = parseFieldContributors(
      JSON.stringify({
        name: [{ sourceId: "name-feed", name: "Name supplier" }],
        details: [{ sourceId: "detail-feed", name: "Detail supplier" }],
        "details.website": [],
        "details.phone": [{ sourceId: "phone-feed", name: "Phone supplier" }],
      }),
    );
    const record = {
      contributors: [{ sourceId: "hidden-feed", name: "Hidden supplier" }],
      fieldContributors: captured,
    };
    expect(contributorsForRecordFields(record, ["name", "details.website", "missing"])).toEqual([
      { sourceId: "name-feed", name: "Name supplier" },
    ]);
    expect(contributorsForRecordFields(record, ["details.address"])).toEqual([
      { sourceId: "detail-feed", name: "Detail supplier" },
    ]);
    const replacement = captureFieldContributors(record, "details", "contact");
    expect(replacement).toEqual({
      contact: [{ sourceId: "detail-feed", name: "Detail supplier" }],
      "contact.website": [],
      "contact.phone": [{ sourceId: "phone-feed", name: "Phone supplier" }],
    });
    expect(
      contributorsForRecordFields({ fieldContributors: replacement }, ["contact.website"]),
    ).toEqual([]);
  });

  it("retains acquisition-time feed metadata and distinct mandatory notices during registry refresh", async () => {
    const metadata: Attribution[] = [
      {
        sourceId: "feed",
        name: "Original",
        publisher: { name: "Old publisher" },
        attributionText: "Dataset notice",
      },
      { sourceId: "feed", name: "Original", attributionText: "Redistribution notice" },
      { sourceId: "unused", name: "Unrelated supplier" },
    ];
    const context = {
      getIntegrationsByDomain: () => [],
      attributionIndex: {
        list: () => metadata,
        getById: (id: string) => metadata.find((row) => row.sourceId === id),
        getForMotisFile: () => undefined,
        dedupAndOrder: (rows: Attribution[]) => rows,
        listMotisFeedTags: () => [],
      },
    };
    async function acquire() {
      const catalogue = captureIntegrationContributorCatalogue(context, "transit");
      const row = await Promise.resolve({ sourceIds: ["feed"] });
      return resolveCapturedContributors(catalogue, "adapter", row);
    }
    const acquisition = acquire();
    metadata[0].name = "Replacement";
    if (metadata[0].publisher) metadata[0].publisher.name = "New publisher";
    const retained = await acquisition;
    expect(retained).toEqual([
      {
        sourceId: "feed",
        name: "Original",
        publisher: { name: "Old publisher" },
        attributionText: "Dataset notice",
      },
      { sourceId: "feed", name: "Original", attributionText: "Redistribution notice" },
    ]);
    expect(snapshotContributors(retained, retained)).toHaveLength(2);
    const catalogue = captureIntegrationContributorCatalogue(context, "transit");
    expect(resolveCapturedContributors(catalogue, "adapter", {})).toEqual([]);
    expect(
      resolveCapturedContributors(catalogue, "adapter", { contributors: [], sourceIds: ["feed"] }),
    ).toEqual([]);
  });
});

it("does not borrow source catalogue metadata when a captured receipt is malformed", () => {
  const receipt = { sourceId: "feed", name: "Known supplier" };
  const catalogue = {
    declaredByIntegration: new Map([["provider", [receipt]]]),
    runtimeById: new Map(),
    hasRuntime: false,
  };
  const evidence = {
    contributors: [{ ...receipt, licensing: { version: 2, bindings: [] } }],
    sourceIds: ["feed"],
  };
  expect(resolveCapturedContributors(catalogue, "provider", evidence, true)).toEqual([]);
  expect(resolveContributors(evidence, () => receipt)).toEqual([]);
});
