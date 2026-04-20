import { describe, expect, it } from "vitest";
import { resolveStyleAssetUrls } from "../src/jobs/download-style.js";

describe("resolveStyleAssetUrls", () => {
  it("returns OpenMapTiles font URL and style entries", () => {
    const urls = resolveStyleAssetUrls();
    expect(urls.fonts).toMatch(/^https?:\/\//);
    expect(urls.styles.length).toBeGreaterThan(0);
    expect(urls.styles.every((style) => style.repo.includes("/") && style.branch)).toBe(true);
  });
});
