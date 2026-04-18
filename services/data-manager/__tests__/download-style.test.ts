import { describe, expect, it } from "vitest";
import { resolveStyleAssetUrls } from "../src/jobs/download-style.js";

describe("resolveStyleAssetUrls", () => {
  it("returns OpenMapTiles font + style + sprite URLs", () => {
    const urls = resolveStyleAssetUrls();
    expect(urls.fonts).toMatch(/^https?:\/\//);
    expect(urls.styles.length).toBeGreaterThan(0);
    expect(urls.sprites).toMatch(/^https?:\/\//);
  });
});
