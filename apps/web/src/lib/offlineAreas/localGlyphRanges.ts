/**
 * Matches MapLibre GL JS's BMP `codePointUsesLocalIdeographFontFamily` and
 * `codePointIsInComplexShapingScript` predicates (`GlyphManager`).
 *
 * MapLibre rasterizes codepoints in these blocks locally via Canvas/TinySDF
 * (unless `localIdeographFontFamily: false` is set, which a regression test
 * guards against) and never requests their PBF range files. Skipping PBF ranges
 * that lie completely inside these blocks trims ~90% of offline glyph storage
 * (`openmaptiles/fonts v2.0`: ~99.8 MiB → ~10.2 MiB).
 */
const LOCAL_IDEOGRAPH_BMP =
  /[\u02EA\u02EB\u1100-\u11FF\u2E80-\u2FDF\u3000-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u4DBF\u4E00-\uA48C\uA490-\uA4C6\uA960-\uA97C\uAC00-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFE10-\uFE1F\uFE30-\uFE4F\uFF00-\uFFEF]/;

const COMPLEX_SHAPING_BMP =
  /[\u0900-\u109F\u1700-\u17FF\u1900-\u194F\u19E0-\u1AAF\u1B00-\u1C4F\u1CC0-\u1CCF\uA800-\uA82F\uA880-\uA8FF\uA930-\uA95F\uA980-\uAAFF\uABC0-\uABFF]/;

export function isLocallyRenderedCodePoint(codePoint: number): boolean {
  const ch = String.fromCodePoint(codePoint);
  return LOCAL_IDEOGRAPH_BMP.test(ch) || COMPLEX_SHAPING_BMP.test(ch);
}

/**
 * Returns true only when every codepoint in a 256-codepoint BMP PBF range
 * (`start-end`) is locally rasterized by MapLibre and therefore never fetched
 * from a glyph server. Any range containing even a single non-local codepoint
 * returns false and stays in the offline download set.
 */
export function isLocallyRenderedGlyphRange(range: string): boolean {
  const match = /^(\d+)-(\d+)$/.exec(range);
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > 0xffff
  ) {
    return false;
  }
  for (let cp = start; cp <= end; cp++) {
    if (!isLocallyRenderedCodePoint(cp)) return false;
  }
  return true;
}
