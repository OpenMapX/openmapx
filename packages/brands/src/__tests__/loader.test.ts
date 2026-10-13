import { afterEach, describe, expect, it, vi } from "vitest";

describe("loadBrandIndex", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("throws for an artifact whose version is not 2", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      readFileSync: () => JSON.stringify({ v: 3, source: "test", license: "test", brands: [] }),
    }));

    const { loadBrandIndex } = await import("../loader");
    expect(() => loadBrandIndex()).toThrow(/Unsupported brand artifact version: 3/);
  });

  it("parses the real artifact and resolves a known qid via byQid", async () => {
    const { loadBrandIndex } = await import("../loader");

    const index = loadBrandIndex();

    expect(index.source).toBe("8.0.20260918");
    expect(index.entries.length).toBeGreaterThan(1000);
    const sample = index.entries[0];
    expect(index.byQid.get(sample.qid)).toBe(sample);
  });
});

it("hydrates the selected artifact field origins into independent portable snapshots", async () => {
  vi.resetModules();
  const nsi = { sourceId: "name-suggestion-index", name: "Captured NSI" };
  const wd = { sourceId: "wikidata", name: "Captured Wikidata" };
  vi.doMock("node:fs", () => ({
    readFileSync: () =>
      JSON.stringify({
        v: 2,
        source: "fixture",
        sourceCredits: [nsi, wd],
        brands: [
          {
            qid: "Q1",
            name: "Selected WD name",
            kind: ["brand"],
            origins: { qid: [nsi.sourceId], name: [nsi.sourceId, wd.sourceId], kind: [] },
          },
        ],
      }),
  }));
  const { loadBrandIndex } = await import("../loader");
  const index = loadBrandIndex();
  expect(index.entries[0].fieldContributors?.name).toEqual([nsi, wd]);
  expect(index.entries[0].fieldContributors?.kind).toEqual([]);
  const capturedName = index.entries[0].fieldContributors?.name[0];
  if (!capturedName) throw new Error("missing captured name receipt");
  capturedName.name = "Mutated field receipt";
  expect(index.entries[0].fieldContributors?.qid[0].name).toBe("Captured NSI");
  vi.doUnmock("node:fs");
  vi.resetModules();
});
