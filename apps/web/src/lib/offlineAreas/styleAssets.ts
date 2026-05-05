import type { TileCoord } from "./tiles";
import { fillTileTemplate } from "./tiles";

interface StyleSource {
  type?: string;
  url?: string;
  tiles?: string[];
  minzoom?: number;
  maxzoom?: number;
}

interface StyleSpec {
  sources?: Record<string, StyleSource>;
  glyphs?: string;
  sprite?: string | { id?: string; url: string }[];
  layers?: { layout?: { "text-font"?: string[] | unknown } }[];
}

interface TileJson {
  tiles?: string[];
  minzoom?: number;
  maxzoom?: number;
}

export interface ResolvedStyleAssets {
  /** Raw style JSON URL → cached as-is. */
  styleUrl: string;
  /** Tile templates with {z}/{x}/{y} placeholders. */
  tileTemplates: string[];
  /**
   * TileJSON URLs encountered via `source.url` declarations. MapLibre fetches
   * these at runtime to discover the tile templates, so the downloader must
   * cache them too — otherwise a "ready" area can't initialize its sources
   * once the runtime caches are emptied.
   */
  tileJsonUrls: string[];
  /** Glyph URLs (templated by {fontstack}/{range}). */
  glyphTemplate?: string;
  /** Distinct font stacks the style references. */
  fontStacks: string[];
  /** Sprite base URLs (no extension). */
  spriteUrls: string[];
}

/**
 * Walks a style JSON and resolves all assets needed to render the map offline:
 * tile URL templates, glyph URL template + fontstacks, and sprite URLs.
 *
 * For sources declared via TileJSON `url`, the TileJSON is fetched to extract
 * the actual tile URL templates.
 */
export async function resolveStyleAssets(
  styleUrl: string,
  styleJson: StyleSpec,
): Promise<ResolvedStyleAssets> {
  const tileTemplates: string[] = [];
  const tileJsonUrls: string[] = [];

  for (const source of Object.values(styleJson.sources ?? {})) {
    if (Array.isArray(source.tiles) && source.tiles.length > 0) {
      tileTemplates.push(...source.tiles);
      continue;
    }
    if (typeof source.url === "string") {
      tileJsonUrls.push(source.url);
      try {
        const tj = (await (await fetch(source.url)).json()) as TileJson;
        if (Array.isArray(tj.tiles)) tileTemplates.push(...tj.tiles);
      } catch {
        // Ignore individual source failures — continue with whatever we have.
      }
    }
  }

  const fontStacks = collectFontStacks(styleJson);
  const spriteUrls = resolveSpriteUrls(styleJson.sprite);

  return {
    styleUrl,
    tileTemplates: dedupe(tileTemplates),
    tileJsonUrls: dedupe(tileJsonUrls),
    glyphTemplate: typeof styleJson.glyphs === "string" ? styleJson.glyphs : undefined,
    fontStacks: dedupe(fontStacks),
    spriteUrls: dedupe(spriteUrls),
  };
}

function collectFontStacks(style: StyleSpec): string[] {
  const stacks = new Set<string>();
  for (const layer of style.layers ?? []) {
    const fonts = layer.layout?.["text-font"];
    if (Array.isArray(fonts)) {
      const names = fonts.filter((f): f is string => typeof f === "string");
      if (names.length > 0) stacks.add(names.join(","));
    }
  }
  return Array.from(stacks);
}

function resolveSpriteUrls(sprite: StyleSpec["sprite"]): string[] {
  if (!sprite) return [];
  if (typeof sprite === "string") return [sprite];
  return sprite.map((s) => s.url);
}

function dedupe<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

/**
 * Generates the full URL list for a tile template + tile coordinate list.
 */
export function tileUrls(template: string, tiles: TileCoord[]): string[] {
  return tiles.map((t) => fillTileTemplate(template, t));
}

/**
 * Glyph PBFs are paged in 256-codepoint ranges. Latin coverage roughly fits in
 * 0-255 + 256-511 + 8192-8447 + 8448-8703 + 64512-65023. This is the same set
 * MapLibre eagerly fetches for typical streets-v2 styles. Caching these covers
 * Latin scripts plus common symbols offline.
 */
export const GLYPH_RANGES = ["0-255", "256-511", "8192-8447", "8448-8703", "64512-65023"] as const;

export function glyphUrls(template: string, fontStacks: string[]): string[] {
  const urls: string[] = [];
  for (const stack of fontStacks) {
    for (const range of GLYPH_RANGES) {
      urls.push(
        template.replace("{fontstack}", encodeURIComponent(stack)).replace("{range}", range),
      );
    }
  }
  return urls;
}

/**
 * Splits a sprite base URL on its query string so suffixes are inserted in the
 * correct position. e.g. `https://x/sprite?key=abc` + `.json` →
 * `https://x/sprite.json?key=abc`. Naive concatenation would produce
 * `https://x/sprite?key=abc.json`, which is invalid.
 */
function appendBeforeQuery(base: string, suffix: string): string {
  const queryIdx = base.indexOf("?");
  if (queryIdx === -1) return `${base}${suffix}`;
  return `${base.slice(0, queryIdx)}${suffix}${base.slice(queryIdx)}`;
}

export function spriteAssetUrls(spriteBase: string): string[] {
  return [
    appendBeforeQuery(spriteBase, ".json"),
    appendBeforeQuery(spriteBase, ".png"),
    appendBeforeQuery(spriteBase, "@2x.json"),
    appendBeforeQuery(spriteBase, "@2x.png"),
  ];
}
