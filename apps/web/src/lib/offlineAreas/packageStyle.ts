import type { OfflineMapPackageManifest } from "@openmapx/core";
import { offlineGlyphCacheNameForVersion } from "../swCaches";
import { offlinePackageApiPath } from "./packageApi";
import { offlinePmtilesTileUrl } from "./packageProtocol";

const GLYPH_FETCH_CONCURRENCY = 8;

type StyleJson = Record<string, unknown> & {
  sources?: Record<string, Record<string, unknown>>;
  glyphs?: string;
  sprite?: string;
  layers?: Array<Record<string, unknown> & { layout?: { "text-font"?: unknown } }>;
};

function cacheName(manifest: OfflineMapPackageManifest): string {
  return offlineGlyphCacheNameForVersion(manifest.glyphs.version);
}

export async function deleteOfflineGlyphCacheIfUnused(
  manifest: OfflineMapPackageManifest,
  remaining: readonly { manifest: OfflineMapPackageManifest }[],
): Promise<void> {
  if (typeof caches === "undefined") return;
  if (remaining.some((record) => record.manifest.glyphs.version === manifest.glyphs.version))
    return;
  await caches.delete(cacheName(manifest));
}

function withVersion(url: string, version: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}offlineGlyphs=${encodeURIComponent(version)}`;
}

function glyphTemplate(manifest: OfflineMapPackageManifest, apiBaseUrl = ""): string {
  return withVersion(
    offlinePackageApiPath(manifest.glyphs.urlTemplate, apiBaseUrl),
    manifest.glyphs.version,
  );
}

async function openPackageAssetCache(
  manifest: OfflineMapPackageManifest,
): Promise<Cache | undefined> {
  if (typeof caches === "undefined") return undefined;
  return await caches.open(cacheName(manifest));
}

async function fetchPinned(url: string, manifest: OfflineMapPackageManifest): Promise<Response> {
  const cache = await openPackageAssetCache(manifest);
  // Store package assets under their manifest path rather than the current API
  // origin. The runtime API host is environment configuration and may change;
  // the immutable glyph version and path are the durable identity.
  const parsed = new URL(
    url,
    typeof window === "undefined" ? "http://localhost/" : window.location.href,
  );
  const cacheKey = `${parsed.pathname}${parsed.search}`;
  const cached = await cache?.match(cacheKey);
  if (cached) return cached.clone();
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok)
    throw new Error(`offline package asset unavailable: ${url} (${response.status})`);
  await cache?.put(cacheKey, response.clone());
  return response;
}

async function fetchConfiguredAsset(url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`online style asset unavailable: ${url} (${response.status})`);
}

async function fetchOptionalConfiguredAsset(url: string): Promise<void> {
  try {
    await fetchConfiguredAsset(url);
  } catch {
    // High-density sprite assets are optional.
  }
}

function fontStacks(style: StyleJson): string[] {
  const values = new Set<string>();
  for (const layer of style.layers ?? []) {
    const fonts = layer.layout?.["text-font"];
    if (Array.isArray(fonts)) {
      const names = fonts.filter((font): font is string => typeof font === "string");
      if (names.length > 0) values.add(names.join(","));
    }
  }
  return [...values];
}

function glyphUrls(template: string, stacks: string[], ranges: string[]): string[] {
  return stacks.flatMap((stack) =>
    ranges.map((range) =>
      template.replace("{fontstack}", encodeURIComponent(stack)).replace("{range}", range),
    ),
  );
}

function glyphCatalogUrl(manifest: OfflineMapPackageManifest, apiBaseUrl = ""): string {
  const suffix = "/{fontstack}/{range}.pbf";
  if (!manifest.glyphs.urlTemplate.endsWith(suffix)) {
    throw new Error("offline package glyph template cannot resolve its catalog");
  }
  return withVersion(
    offlinePackageApiPath(
      `${manifest.glyphs.urlTemplate.slice(0, -suffix.length)}/catalog.json`,
      apiBaseUrl,
    ),
    manifest.glyphs.version,
  );
}

function glyphCompletionUrl(manifest: OfflineMapPackageManifest): string {
  return `/__openmapx/offline-glyphs/${encodeURIComponent(manifest.glyphs.version)}/complete`;
}

export async function hasOfflineGlyphAssets(manifest: OfflineMapPackageManifest): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    const cache = await caches.open(cacheName(manifest));
    return (await cache.match(glyphCompletionUrl(manifest))) !== undefined;
  } catch {
    return false;
  }
}

function validateGlyphCatalog(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("offline package glyph catalog is invalid");
  }
  const catalog: Record<string, string[]> = {};
  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.length > 256) {
    throw new Error("offline package glyph catalog is empty or too large");
  }
  for (const [font, value] of entries) {
    if (!font || font.length > 256 || !Array.isArray(value) || value.length > 512) {
      throw new Error("offline package glyph catalog is invalid");
    }
    const ranges = value.filter((range): range is string => {
      if (typeof range !== "string") return false;
      const match = /^(\d+)-(\d+)$/.exec(range);
      if (!match) return false;
      const start = Number(match[1]);
      const end = Number(match[2]);
      return (
        Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start >= 0 &&
        start <= 65_280 &&
        start % 256 === 0 &&
        end === start + 255
      );
    });
    if (ranges.length !== value.length || ranges.length === 0) {
      throw new Error("offline package glyph catalog contains an invalid range");
    }
    catalog[font] = [...new Set(ranges)];
  }
  return catalog;
}

function rangesForStack(catalog: Record<string, string[]>, stack: string): string[] {
  const fonts = stack.split(",").map((font) => font.trim());
  const ranges = fonts.map((font) => catalog[font]);
  if (ranges.some((value) => !value)) {
    throw new Error(`offline package has no glyph catalog for style font stack: ${stack}`);
  }
  const [first, ...rest] = ranges as string[][];
  return first.filter((range) => rest.every((candidate) => candidate.includes(range)));
}

async function fetchPinnedGlyphs(
  urls: string[],
  manifest: OfflineMapPackageManifest,
): Promise<void> {
  for (let offset = 0; offset < urls.length; offset += GLYPH_FETCH_CONCURRENCY) {
    await Promise.all(
      urls.slice(offset, offset + GLYPH_FETCH_CONCURRENCY).map((url) => fetchPinned(url, manifest)),
    );
  }
}

function spriteAssetUrl(sprite: string, suffix: ".json" | ".png" | "@2x.json" | "@2x.png"): string {
  const queryIndex = sprite.search(/[?#]/);
  if (queryIndex < 0) return `${sprite}${suffix}`;
  return `${sprite.slice(0, queryIndex)}${suffix}${sprite.slice(queryIndex)}`;
}

async function validateOnlineStyleAssets(styles: {
  light: StyleJson;
  dark: StyleJson;
}): Promise<void> {
  const fetched = new Set<string>();
  for (const [variant, style] of Object.entries(styles)) {
    if (!style.sources?.openmaptiles) {
      throw new Error(`OpenMapX ${variant} style has no vector source`);
    }
    if (typeof style.glyphs !== "string") {
      throw new Error(`OpenMapX ${variant} style has no glyph template`);
    }
    if (typeof style.sprite !== "string") {
      throw new Error(`OpenMapX ${variant} style has no sprite template`);
    }

    const required = [spriteAssetUrl(style.sprite, ".json"), spriteAssetUrl(style.sprite, ".png")];
    for (const url of required) {
      if (fetched.has(url)) continue;
      await fetchConfiguredAsset(url);
      fetched.add(url);
    }
    for (const suffix of ["@2x.json", "@2x.png"] as const) {
      const url = spriteAssetUrl(style.sprite, suffix);
      if (fetched.has(url)) continue;
      await fetchOptionalConfiguredAsset(url);
      fetched.add(url);
    }
  }
}

export async function validateOfflineStyleAssets(
  manifest: OfflineMapPackageManifest,
  styles: { light: Record<string, unknown>; dark: Record<string, unknown> },
  options: { apiBaseUrl?: string } = {},
): Promise<void> {
  const cache = await openPackageAssetCache(manifest);
  if (!cache) {
    throw new Error("Cache Storage is required to keep offline map glyphs");
  }
  const apiBaseUrl = options.apiBaseUrl ?? "";
  await cache.delete(glyphCompletionUrl(manifest));
  const typedStyles = {
    light: styles.light as StyleJson,
    dark: styles.dark as StyleJson,
  };
  await validateOnlineStyleAssets(typedStyles);
  const catalogResponse = await fetchPinned(glyphCatalogUrl(manifest, apiBaseUrl), manifest);
  const catalog = validateGlyphCatalog(await catalogResponse.json());
  const stacks = [...new Set(Object.values(typedStyles).flatMap(fontStacks))];
  const urls = new Set<string>();
  for (const stack of stacks) {
    const ranges = rangesForStack(catalog, stack);
    if (ranges.length === 0) {
      throw new Error(`offline package has no common glyph ranges for style font stack: ${stack}`);
    }
    for (const url of glyphUrls(glyphTemplate(manifest, apiBaseUrl), [stack], ranges))
      urls.add(url);
  }
  await fetchPinnedGlyphs([...urls], manifest);
  await cache.put(
    glyphCompletionUrl(manifest),
    new Response(JSON.stringify({ glyphsVersion: manifest.glyphs.version }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
}

export function resolveOfflinePackageStyle(
  configuredStyle: Record<string, unknown>,
  packages: readonly { packageId: string; manifest: OfflineMapPackageManifest }[],
  options: { apiBaseUrl?: string } = {},
): Record<string, unknown> {
  if (packages.length === 0) throw new Error("at least one offline package is required");
  const style = configuredStyle as StyleJson;
  const source = style.sources?.openmaptiles;
  if (!source) throw new Error("OpenMapX style has no openmaptiles source");

  const uniquePackages = [...new Map(packages.map((item) => [item.packageId, item])).values()].sort(
    (a, b) => {
      const area = (item: typeof a) => {
        const bbox = item.manifest.coverage.bbox;
        return (bbox.east - bbox.west) * (bbox.north - bbox.south);
      };
      return (
        area(a) - area(b) ||
        b.manifest.dataset.generatedAt.localeCompare(a.manifest.dataset.generatedAt) ||
        a.packageId.localeCompare(b.packageId)
      );
    },
  );
  const packageIds = uniquePackages.map((item) => item.packageId);
  const typedManifests = uniquePackages.map((item) => item.manifest);
  const glyphManifest = [...typedManifests].sort(
    (a, b) =>
      b.dataset.generatedAt.localeCompare(a.dataset.generatedAt) ||
      a.packageId.localeCompare(b.packageId),
  )[0];
  const bounds = typedManifests.reduce(
    (value, manifest) => [
      Math.min(value[0], manifest.coverage.bbox.west),
      Math.min(value[1], manifest.coverage.bbox.south),
      Math.max(value[2], manifest.coverage.bbox.east),
      Math.max(value[3], manifest.coverage.bbox.north),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  const primarySource: Record<string, unknown> = {
    ...source,
    tiles: [offlinePmtilesTileUrl(packageIds)],
    bounds,
    minzoom: Math.min(...typedManifests.map((manifest) => manifest.coverage.minZoom)),
    // A single MapLibre source cannot advertise a different native maximum per
    // package. Use the shared maximum so MapLibre overzooms everywhere above
    // it instead of requesting native tiles that lower-zoom packages lack.
    maxzoom: Math.min(...typedManifests.map((manifest) => manifest.coverage.maxZoom)),
    attribution: "",
  };
  delete primarySource.url;

  return {
    ...configuredStyle,
    sources: { ...(style.sources ?? {}), openmaptiles: primarySource },
    glyphs: glyphTemplate(glyphManifest, options.apiBaseUrl),
  };
}
