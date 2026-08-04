import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENMAPTILES_FONTS_URL,
  resolveFontAssetUrl,
  validateFontArchiveEntries,
} from "../src/jobs/download-fonts.js";

describe("resolveFontAssetUrl", () => {
  it("uses the pinned default and supports an operator mirror", () => {
    expect(resolveFontAssetUrl({})).toBe(DEFAULT_OPENMAPTILES_FONTS_URL);
    expect(
      resolveFontAssetUrl({ OPENMAPTILES_FONTS_URL: " https://assets.example/fonts.zip " }),
    ).toBe("https://assets.example/fonts.zip");
  });

  it("rejects archive paths that could escape the staging directory", () => {
    expect(() => validateFontArchiveEntries(["Noto Sans/0-255.pbf"])).not.toThrow();
    expect(() => validateFontArchiveEntries(["../outside"])).toThrow(/unsafe path/);
    expect(() => validateFontArchiveEntries(["/absolute/path"])).toThrow(/unsafe path/);
    expect(() => validateFontArchiveEntries(["..\\outside"])).toThrow(/unsafe path/);
  });
});
