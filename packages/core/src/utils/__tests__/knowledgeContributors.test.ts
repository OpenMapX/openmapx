import { describe, expect, it } from "vitest";
import type { AddressEvidence } from "../../types/address";
import { captureKnowledgeResult, mergeKnowledgeResults } from "../knowledgeContributors";

const a = { sourceId: "a", name: "First", attributionText: "Original notice" };
const b = { sourceId: "b", name: "Second" };
const addressEvidence: AddressEvidence = {
  source: "a",
  method: "provider-address",
  components: { full: "Main St 1" },
};

it("carries address evidence atomically through capture and merge", () => {
  const captured = captureKnowledgeResult({ address: "Main St 1", addressEvidence }, [a]);
  expect(captured.addressEvidence).toEqual(addressEvidence);
  expect(captured.fieldContributors?.addressEvidence).toEqual([a]);
  const result = mergeKnowledgeResults([
    captured,
    {
      address: "Other St 2",
      addressEvidence: { ...addressEvidence, source: "b", components: { full: "Other St 2" } },
      contributors: [b],
    },
  ]);
  expect(result.address).toBe("Main St 1");
  expect(result.addressEvidence).toEqual(addressEvidence);
  expect(result.fieldContributors?.addressEvidence).toEqual([a]);
  const legacy = mergeKnowledgeResults([
    { address: "Main St 1", contributors: [a] },
    { address: "Other St 2", addressEvidence, contributors: [b] },
  ]);
  expect(legacy.addressEvidence).toBeUndefined();
  expect(legacy.fieldContributors?.addressEvidence).toBeUndefined();
});

describe("knowledge field ownership", () => {
  it("keeps winning fields and added identifiers while excluding discarded source fields", () => {
    const result = mergeKnowledgeResults([
      { description: "First description", externalIds: { yelp: "first" }, contributors: [a] },
      {
        description: "Discarded",
        phone: "+49",
        externalIds: { yelp: "discarded", instagram: "second" },
        contributors: [b],
      },
    ]);
    expect(result.description).toBe("First description");
    expect(result.externalIds).toEqual({ yelp: "first", instagram: "second" });
    expect(result.fieldContributors?.description).toEqual([a]);
    expect(result.fieldContributors?.phone).toEqual([b]);
    expect(result.fieldContributors?.["externalIds.yelp"]).toEqual([a]);
    expect(result.fieldContributors?.["externalIds.instagram"]).toEqual([b]);
    a.attributionText = "Changed catalogue";
    expect(result.fieldContributors?.description[0]?.attributionText).toBe("Original notice");
    a.attributionText = "Original notice";
  });

  it("does not expand a missing field in an authoritative mixed-field map", () => {
    const result = mergeKnowledgeResults([
      {
        description: "Known",
        phone: "+49",
        contributors: [a, b],
        fieldContributors: { description: [a] },
      },
      { description: "Discarded", contributors: [b] },
    ]);
    expect(result.fieldContributors?.description).toEqual([a]);
    expect(result.fieldContributors?.phone).toEqual([]);
    expect(result.contributors).toEqual([a]);
  });

  it("retains item receipts and explicit empty receipts without borrowing scalar credits", () => {
    const photo = { url: "https://example.com/a", source: "photo", contributors: [b] };
    const fact = { label: "Founded", value: "1900", contributors: [] };
    const result = mergeKnowledgeResults([{ photos: [photo], facts: [fact], contributors: [a] }]);
    expect(result.photos?.[0]?.contributors).toEqual([b]);
    expect(result.facts?.[0]?.contributors).toEqual([]);
    expect(result.contributors).toEqual([b]);
    photo.contributors[0].name = "Caller mutation";
    expect(result.photos?.[0]?.contributors?.[0]?.name).toBe("Second");
    b.name = "Second";
  });
});

it("keeps an authoritative empty parent receipt for legacy facts during trusted adapter capture", () => {
  const result = captureKnowledgeResult(
    { contributors: [], facts: [{ label: "Founded", value: "1900" }] },
    [a],
  );
  expect(result.facts?.[0]?.contributors).toEqual([]);
  expect(result.contributors).toEqual([]);
});

it("copies nested property ownership through the winning knowledge value", () => {
  const result = mergeKnowledgeResults([
    {
      names: { de: "Name", en: "Name EN" },
      brand: { name: "Brand", wikidata: "Q1" },
      fieldContributors: {
        names: [a, b],
        "names.de": [a],
        "names.en": [b],
        brand: [a, b],
        "brand.name": [a],
        "brand.wikidata": [b],
      },
      contributors: [a, b],
    },
    { names: { fr: "Discarded" }, fieldContributors: { "names.fr": [b] } },
  ]);
  expect(result.fieldContributors?.["names.de"]).toEqual([a]);
  expect(result.fieldContributors?.["names.en"]).toEqual([b]);
  expect(result.fieldContributors?.["brand.wikidata"]).toEqual([b]);
  expect(result.fieldContributors?.["names.fr"]).toBeUndefined();
});

it("trusted capture preserves child-only and explicit empty nested ownership", () => {
  const result = captureKnowledgeResult(
    {
      brand: { name: "Brand", wikidata: "Q1" },
      names: { en: "English" },
      fieldContributors: { "brand.name": [a], "brand.wikidata": [], "names.en": [b] },
    },
    [b],
  );
  expect(result.fieldContributors?.["brand.name"]).toEqual([a]);
  expect(result.fieldContributors?.["brand.wikidata"]).toEqual([]);
  expect(result.fieldContributors?.["names.en"]).toEqual([b]);
  expect(result.fieldContributors?.brand).toEqual([]);
});
