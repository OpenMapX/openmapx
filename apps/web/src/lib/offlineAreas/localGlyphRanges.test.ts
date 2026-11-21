import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isLocallyRenderedCodePoint, isLocallyRenderedGlyphRange } from "./localGlyphRanges";

const WEB_SRC_ROOT = join(import.meta.dirname, "../..");
const MAPLIBRE_UNICODE_PROPERTIES_PATH = join(
  dirname(fileURLToPath(import.meta.resolve("maplibre-gl/package.json"))),
  "src/util/unicode_properties.g.ts",
);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated" || entry.name === "__tests__") continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("isLocallyRenderedGlyphRange", () => {
  it("matches the installed MapLibre unicode_properties predicates across the entire BMP", async () => {
    const maplibreUnicode = (await import(
      /* @vite-ignore */ pathToFileURL(MAPLIBRE_UNICODE_PROPERTIES_PATH).href
    )) as {
      codePointUsesLocalIdeographFontFamily: (cp: number) => boolean;
      codePointIsInComplexShapingScript: (cp: number) => boolean;
    };

    const mismatches: number[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      const expected =
        maplibreUnicode.codePointUsesLocalIdeographFontFamily(cp) ||
        maplibreUnicode.codePointIsInComplexShapingScript(cp);
      if (isLocallyRenderedCodePoint(cp) !== expected) {
        mismatches.push(cp);
        if (mismatches.length >= 10) break;
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("skips BMP ranges that sit completely inside MapLibre's local-drawing blocks", () => {
    expect(isLocallyRenderedGlyphRange("19968-20223")).toBe(true); // CJK Unified Ideographs
    expect(isLocallyRenderedGlyphRange("44032-44287")).toBe(true); // Hangul Syllables
    expect(isLocallyRenderedGlyphRange("2304-2559")).toBe(true); // Devanagari + Bengali
    expect(isLocallyRenderedGlyphRange("3584-3839")).toBe(true); // Thai + Lao
    expect(isLocallyRenderedGlyphRange("5888-6143")).toBe(true); // Khmer
  });

  it("keeps ranges with any codepoint that MapLibre fetches from the glyph server", () => {
    expect(isLocallyRenderedGlyphRange("0-255")).toBe(false); // Basic Latin
    expect(isLocallyRenderedGlyphRange("1024-1279")).toBe(false); // Cyrillic
    expect(isLocallyRenderedGlyphRange("1536-1791")).toBe(false); // Arabic
    expect(isLocallyRenderedGlyphRange("1792-2047")).toBe(false); // Arabic Supp + Thaana
    expect(isLocallyRenderedGlyphRange("4096-4351")).toBe(false); // Myanmar (local) + Georgian (PBF)
    expect(isLocallyRenderedGlyphRange("4608-4863")).toBe(false); // Ethiopic
    expect(isLocallyRenderedGlyphRange("6400-6655")).toBe(false); // New Tai Lue gap inside U+1950-19DF
    expect(isLocallyRenderedGlyphRange("11520-11775")).toBe(false); // Glagolitic / Coptic / Tifinagh
    expect(isLocallyRenderedGlyphRange("invalid")).toBe(false);
  });

  it("guards against overriding localIdeographFontFamily away from MapLibre's default", () => {
    // Offline glyph range trimming relies on MapLibre keeping its default local
    // ideograph rasterization enabled ('sans-serif'). Any falsy value (false, "",
    // undefined, or a dynamic variable) would disable local drawing and leave
    // trimmed scripts blank offline.
    const offenders: string[] = [];
    for (const file of listSourceFiles(WEB_SRC_ROOT)) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      for (const match of code.matchAll(/localIdeographFontFamily\s*:\s*([^\n,;}]+)/g)) {
        const value = match[1]?.trim() ?? "";
        if (value !== '"sans-serif"' && value !== "'sans-serif'") {
          offenders.push(`${file}: ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
