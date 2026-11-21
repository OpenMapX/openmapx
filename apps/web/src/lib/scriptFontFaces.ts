import type { FontFacesSpecification, MLFontFace } from "maplibre-gl";

export interface BundledScriptFont {
  readonly path: string;
  readonly version: string;
  readonly unicodeRange: readonly string[];
}

/**
 * Self-hosted OFL WOFF2 subsets for Unicode scripts whose PBF range files
 * exist (HTTP 200) in OpenFreeMap and `openmaptiles/fonts v2.0` but contain
 * zero glyphs for these blocks. Narrow `unicode-range` bounds keep MapLibre
 * from overriding covered PBF glyphs outside each script.
 */
export const BUNDLED_SCRIPT_FONTS: readonly BundledScriptFont[] = [
  {
    path: "/fonts/scripts/NotoSansTifinagh-Regular.woff2",
    version: "2.006",
    unicodeRange: ["U+2D30-2D7F"],
  },
  {
    path: "/fonts/scripts/NotoSansThaana-Regular.woff2",
    version: "3.001",
    unicodeRange: ["U+0780-07B1"],
  },
  {
    path: "/fonts/scripts/NotoSansCanadianAboriginal-Regular.woff2",
    version: "2.004",
    unicodeRange: ["U+1400-167F", "U+18B0-18F5", "U+11AB0-11ABF"],
  },
  {
    path: "/fonts/scripts/NotoSansNewTaiLue-Regular.woff2",
    version: "2.004",
    unicodeRange: ["U+1980-19DF"],
  },
  {
    path: "/fonts/scripts/NotoSansCherokee-Regular.woff2",
    version: "2.001",
    unicodeRange: ["U+13A0-13FF", "U+AB70-ABBF"],
  },
  {
    path: "/fonts/scripts/NotoSansOlChiki-Regular.woff2",
    version: "2.003",
    unicodeRange: ["U+1C50-1C7F"],
  },
];

/** Deterministic version identifier for the bundled script fallback font set. */
export const SCRIPT_FONT_SET_VERSION = BUNDLED_SCRIPT_FONTS.map(
  (font) => `${font.path}@${font.version}`,
).join(",");

const BASEMAP_FONT_NAMES = ["Noto Sans Regular", "Noto Sans Bold", "Noto Sans Italic"] as const;

function resolveFontUrl(font: BundledScriptFont, origin?: string): string {
  const base = origin?.replace(/\/$/, "");
  const versionedPath = `${font.path}?v=${encodeURIComponent(font.version)}`;
  return base ? `${base}${versionedPath}` : versionedPath;
}

/**
 * Build the MapLibre root `font-faces` map for the owned OpenMapX styles.
 * Each of the three Noto Sans weights maps to the same narrow-range script
 * fallback files so bold/italic layers never lose a gap script either.
 * MapLibre's FontFaceManager loads and registers separate FontFace instances
 * per declared font name, so a file may be requested up to three times; the
 * versioned query string lets the service worker serve repeats from cache.
 */
export function buildScriptFontFaces(origin?: string): FontFacesSpecification {
  const faces: MLFontFace[] = BUNDLED_SCRIPT_FONTS.map((font) => ({
    url: resolveFontUrl(font, origin),
    "unicode-range": [...font.unicodeRange],
  }));
  const spec: FontFacesSpecification = {};
  for (const name of BASEMAP_FONT_NAMES) {
    spec[name] = faces.map((face) => ({
      url: face.url,
      ...(face["unicode-range"] ? { "unicode-range": [...face["unicode-range"]] } : {}),
    }));
  }
  return spec;
}

/** Collect every unique font file URL declared in a style's `font-faces` map. */
export function collectStyleFontFaceUrls(fontFaces: unknown): string[] {
  if (!fontFaces || typeof fontFaces !== "object" || Array.isArray(fontFaces)) return [];
  const urls = new Set<string>();
  for (const value of Object.values(fontFaces as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      urls.add(value);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const face of value) {
      if (typeof face === "string" && face.length > 0) {
        urls.add(face);
      } else if (
        face &&
        typeof face === "object" &&
        typeof (face as { url?: unknown }).url === "string" &&
        (face as { url: string }).url.length > 0
      ) {
        urls.add((face as { url: string }).url);
      }
    }
  }
  return [...urls];
}

/** Rewrite every URL inside a style's `font-faces` declaration without mutating the input. */
export function rewriteStyleFontFaces(
  fontFaces: unknown,
  rewriteUrl: (url: string) => string,
): Record<string, unknown> | undefined {
  if (!fontFaces || typeof fontFaces !== "object" || Array.isArray(fontFaces)) return undefined;
  const rewritten: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fontFaces as Record<string, unknown>)) {
    if (typeof value === "string") {
      rewritten[name] = rewriteUrl(value);
      continue;
    }
    if (Array.isArray(value)) {
      rewritten[name] = value.map((face) => {
        if (typeof face === "string") return rewriteUrl(face);
        if (
          face &&
          typeof face === "object" &&
          typeof (face as { url?: unknown }).url === "string"
        ) {
          return {
            ...(face as Record<string, unknown>),
            url: rewriteUrl((face as { url: string }).url),
          };
        }
        return face;
      });
      continue;
    }
    rewritten[name] = value;
  }
  return rewritten;
}
