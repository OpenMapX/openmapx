import { describe, expect, it } from "vitest";
import { buildArtifact } from "../generate";

describe("buildArtifact", () => {
  it("produces a v2 artifact with a plausible number of brands", () => {
    const artifact = buildArtifact();
    expect(artifact.v).toBe(2);
    expect(artifact.license).toContain("BSD-3-Clause");
    expect(artifact.brands.length).toBeGreaterThan(20_000);
  });

  it("is deterministic — two builds serialize identically", () => {
    expect(JSON.stringify(buildArtifact())).toBe(JSON.stringify(buildArtifact()));
  });

  it("never emits a Facebook or Twitter logo URL", () => {
    const serialized = JSON.stringify(buildArtifact());
    expect(serialized).not.toContain("facebook.com");
    expect(serialized).not.toContain("graph.facebook");
    expect(serialized).not.toContain("twimg.com");
  });

  it("stores bare Commons filenames, not URLs", () => {
    const withLogo = buildArtifact().brands.filter((b) => b.logoFile);
    expect(withLogo.length).toBeGreaterThan(5_000);
    for (const brand of withLogo.slice(0, 200)) {
      expect(brand.logoFile).not.toContain("http");
      expect(brand.logoFile).not.toContain("/");
    }
  });

  it("normalizes matchNames to lowercase without diacritics", () => {
    for (const brand of buildArtifact().brands.slice(0, 500)) {
      for (const name of brand.matchNames) {
        expect(name).toBe(name.toLowerCase());
        expect(name).not.toMatch(/[̀-ͯ]/);
      }
    }
  });

  it("gives every entry at least one kind", () => {
    for (const brand of buildArtifact().brands.slice(0, 500)) {
      expect(brand.kind.length).toBeGreaterThan(0);
    }
  });
});

it("records selected source origins for Wikidata fields and NSI fallback names at generation", () => {
  const artifact = buildArtifact({
    version: "fixture",
    nsi: {
      "brands/shop/test": {
        items: [
          { displayName: "NSI one", tags: { "brand:wikidata": "Q1", shop: "test" } },
          { displayName: "NSI fallback", tags: { "brand:wikidata": "Q2", shop: "test" } },
        ],
      },
    },
    wikidata: {
      Q1: {
        label: "Selected Wikidata name",
        description: "Selected description",
        officialWebsites: ["https://brand.example"],
        logos: { wikidata: "https://commons.wikimedia.org/wiki/Special:FilePath/Logo.svg" },
      },
    },
  });
  expect(artifact.v).toBe(2);
  expect(artifact.brands.find((brand) => brand.qid === "Q1")).toMatchObject({
    name: "Selected Wikidata name",
    origins: {
      name: ["name-suggestion-index", "wikidata"],
      description: ["name-suggestion-index", "wikidata"],
      website: ["name-suggestion-index", "wikidata"],
      logoFile: ["name-suggestion-index", "wikidata"],
      matchNames: ["name-suggestion-index"],
    },
  });
  expect(artifact.brands.find((brand) => brand.qid === "Q2")).toMatchObject({
    name: "NSI fallback",
    origins: { name: ["name-suggestion-index"] },
  });
  expect(artifact.inputHashes.wikidata).toMatch(/^[a-f0-9]{64}$/);
  expect(artifact.sourceCredits.map((receipt) => receipt.sourceId)).toEqual([
    "name-suggestion-index",
    "wikidata",
  ]);
});
