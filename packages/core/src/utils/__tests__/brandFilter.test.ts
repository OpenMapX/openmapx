import { describe, expect, it, vi } from "vitest";
import { BRAND_QID_KEYS, brandToFilter, commonsLogoUrl, gapFillBranding } from "../brandFilter";
import { validateOverpassFilter } from "../overpassFilter";

describe("brandToFilter", () => {
  it("emits one selector for a brand-only identity", () => {
    expect(brandToFilter({ qid: "Q41171", kind: ["brand"] })).toEqual({
      selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q41171" }] }],
    });
  });

  it("emits one selector per kind, in a stable order", () => {
    const filter = brandToFilter({ qid: "Q1", kind: ["operator", "brand", "network"] });
    expect(filter.selectors.map((s) => s.tags[0].key)).toEqual([
      "brand:wikidata",
      "network:wikidata",
      "operator:wikidata",
    ]);
    for (const selector of filter.selectors) {
      expect(selector.tags[0].value).toBe("Q1");
    }
  });

  it("produces a filter that passes validation", () => {
    const result = validateOverpassFilter(
      brandToFilter({ qid: "Q1", kind: ["brand", "operator"] }),
    );
    expect(result.ok).toBe(true);
  });

  it("falls back to the brand key when kind is empty", () => {
    expect(brandToFilter({ qid: "Q1", kind: [] }).selectors).toEqual([
      { tags: [{ key: "brand:wikidata", op: "=", value: "Q1" }] },
    ]);
  });
});

describe("BRAND_QID_KEYS", () => {
  it("lists the QID keys in precedence order", () => {
    expect(BRAND_QID_KEYS).toEqual(["brand:wikidata", "network:wikidata", "operator:wikidata"]);
  });
});

describe("commonsLogoUrl", () => {
  it("builds a Special:FilePath URL at the requested width", () => {
    expect(commonsLogoUrl("Starbucks Corporation Logo.svg", 64)).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Starbucks%20Corporation%20Logo.svg?width=64",
    );
  });

  it("encodes characters that would otherwise break the path", () => {
    expect(commonsLogoUrl("A&W logo.svg", 64)).toContain("A%26W");
  });

  it("defaults to a 64px render", () => {
    expect(commonsLogoUrl("x.svg")).toContain("width=64");
  });
});

describe("gapFillBranding", () => {
  const catalogued = { qid: "Q1", name: "Catalogued Brand", logoFile: "Catalogued Brand Logo.svg" };
  const resolvableTags = { "brand:wikidata": "Q1" };

  it("never overwrites an existing logoUrl, even when the tags resolve a catalog brand", () => {
    const existing = { name: "Feed's Own Name", logoUrl: "https://feed.example/logo.png" };
    const resolveBrand = vi.fn(() => catalogued);

    expect(gapFillBranding(existing, resolvableTags, resolveBrand)).toBe(existing);
  });

  it("keeps catalog identity without creating an uncredited Commons logo", () => {
    const existing = { name: "Feed's Own Name", color: "#ff0000" };
    const resolveBrand = vi.fn(() => catalogued);

    expect(gapFillBranding(existing, resolvableTags, resolveBrand)).toEqual({
      name: "Feed's Own Name",
      color: "#ff0000",
      catalogueLogo: { qid: "Q1", file: catalogued.logoFile },
      contributors: [],
      fieldContributors: { name: [], color: [], "catalogueLogo.qid": [], "catalogueLogo.file": [] },
    });
  });

  it("fills in the catalog name without uncredited logo bytes", () => {
    const resolveBrand = vi.fn(() => catalogued);

    expect(gapFillBranding(undefined, resolvableTags, resolveBrand)).toEqual({
      name: catalogued.name,
      contributors: [],
      fieldContributors: { name: [], "catalogueLogo.qid": [], "catalogueLogo.file": [] },
      catalogueLogo: { qid: "Q1", file: catalogued.logoFile },
    });
  });

  it("returns undefined when existing is undefined and nothing resolves", () => {
    const resolveBrand = vi.fn(() => undefined);

    expect(gapFillBranding(undefined, undefined, resolveBrand)).toBeUndefined();
  });
});

it("captures label and file selection independently without uncredited image bytes", () => {
  const name = { sourceId: "wikidata", name: "Actual label supplier" };
  const logo = { sourceId: "hidden-logo", name: "Hidden filename" };
  const branding = gapFillBranding(undefined, {}, () => ({
    qid: "Q1",
    name: "Catalogue supplied brand",
    logoFile: "Logo.svg",
    contributors: [name, logo],
    fieldContributors: { qid: [name], name: [name], logoFile: [logo] },
  }));
  expect(branding).toMatchObject({
    name: "Catalogue supplied brand",
    contributors: [name, logo],
    fieldContributors: {
      name: [name],
      "catalogueLogo.qid": [name],
      "catalogueLogo.file": [logo],
    },
  });
  expect(branding?.logoUrl).toBeUndefined();
});

it("preserves a place label while projecting the catalogue's selected logo field only", async () => {
  const { brandForPlaceLogo } = await import("../brandFilter");
  const placeCredit = { sourceId: "place", name: "Place label" },
    fileHint = { sourceId: "wikidata", name: "Selected file hint" },
    hidden = { sourceId: "hidden", name: "Hidden catalogue description" };
  const row = brandForPlaceLogo(
    {
      name: "Place name",
      contributors: [placeCredit],
      fieldContributors: { name: [placeCredit], "osmTags.brand:wikidata": [placeCredit] },
    },
    {
      qid: "Q1",
      name: "Different catalogue name",
      kind: ["brand"],
      logoFile: "Logo.svg",
      contributors: [fileHint, hidden],
      fieldContributors: { logoFile: [fileHint], name: [hidden], description: [hidden] },
    },
    "Q1",
    "brand",
  );
  expect(row.name).toBe("Place name");
  expect(row.fieldContributors?.name).toEqual([placeCredit]);
  expect(row.fieldContributors?.logoFile).toEqual([fileHint]);
  expect(row.contributors).not.toContainEqual(hidden);
});

it("carries a captured catalogue logo reference without manufacturing image URLs", () => {
  const label = { sourceId: "label", name: "Catalogue label" };
  const file = { sourceId: "selection", name: "Selected file" };
  const branding = gapFillBranding({ name: "Feed label" }, {}, () => ({
    qid: "Q1",
    name: "Catalogue label",
    logoFile: "Logo.svg",
    fieldContributors: { qid: [label], name: [label], logoFile: [file] },
  }));
  expect(branding).toMatchObject({
    name: "Feed label",
    catalogueLogo: { qid: "Q1", file: "Logo.svg" },
    fieldContributors: { "catalogueLogo.qid": [label], "catalogueLogo.file": [file] },
  });
  expect(branding?.logoUrl).toBeUndefined();
});

it("preserves an existing captured file selection and supplied image without relabelling", () => {
  const resolve = vi.fn(() => ({ qid: "Q2", name: "Other catalogue", logoFile: "Other.svg" }));
  for (const existing of [
    { name: "Supplied", catalogueLogo: { qid: "Q1", file: "Captured.svg" } },
    { name: "Supplied", imageUrl: "https://feed.test/image.png" },
  ])
    expect(gapFillBranding(existing, {}, resolve)).toBe(existing);
  expect(resolve).not.toHaveBeenCalled();
});
