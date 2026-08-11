import { afterEach, describe, expect, it, vi } from "vitest";

describe("loadBrandIndex", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("throws for an artifact whose version is not 1", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      readFileSync: () => JSON.stringify({ v: 2, source: "test", license: "test", brands: [] }),
    }));

    const { loadBrandIndex } = await import("../loader");
    expect(() => loadBrandIndex()).toThrow(/Unsupported brand artifact version: 2/);
  });

  it("parses the real artifact and resolves a known qid via byQid", async () => {
    const { loadBrandIndex } = await import("../loader");

    const index = loadBrandIndex();

    expect(index.source).toBe("8.0.20260729");
    expect(index.entries.length).toBeGreaterThan(1000);
    const sample = index.entries[0];
    expect(index.byQid.get(sample.qid)).toBe(sample);
  });
});
