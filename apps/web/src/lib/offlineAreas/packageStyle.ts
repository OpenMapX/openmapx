import type { OfflineMapPackageManifest } from "@openmapx/core";
import { offlineStyleCacheNameForVersion } from "../swCaches";
import { offlinePmtilesTileUrl } from "./packageProtocol";
import type { OfflinePackageStyleAssets } from "./types";

const GLYPH_RANGES = ["0-255", "256-511", "8192-8447", "8448-8703", "64512-65023"];

type StyleJson = Record<string, unknown> & {
  sources?: Record<string, Record<string, unknown>>;
  glyphs?: string;
  sprite?: string | { url: string; id?: string }[];
  layers?: Array<{ layout?: { "text-font"?: unknown } }>;
};

function cacheName(manifest: OfflineMapPackageManifest): string {
  return offlineStyleCacheNameForVersion(manifest.style.version);
}

function withVersion(url: string, version: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}offlineStyle=${encodeURIComponent(version)}`;
}

function variantDirectory(variant: "light" | "dark"): "osm-bright" | "dark-matter" {
  return variant === "dark" ? "dark-matter" : "osm-bright";
}

function assetUrl(manifest: OfflineMapPackageManifest, path: string): string {
  return withVersion(
    `${manifest.style.assetBaseUrl.replace(/\/$/, "")}/${path}`,
    manifest.style.version,
  );
}

function styleUrl(manifest: OfflineMapPackageManifest, variant: "light" | "dark"): string {
  return assetUrl(manifest, `styles/${variantDirectory(variant)}/style.json`);
}

function spriteBaseUrl(manifest: OfflineMapPackageManifest, variant: "light" | "dark"): string {
  return assetUrl(manifest, `styles/${variantDirectory(variant)}/sprite`);
}

function glyphTemplate(manifest: OfflineMapPackageManifest): string {
  return assetUrl(manifest, "fonts/{fontstack}/{range}.pbf");
}

async function openStyleCache(manifest: OfflineMapPackageManifest): Promise<Cache | undefined> {
  if (typeof caches === "undefined") return undefined;
  return await caches.open(cacheName(manifest));
}

async function fetchPinned(url: string, manifest: OfflineMapPackageManifest): Promise<Response> {
  const cache = await openStyleCache(manifest);
  const cached = await cache?.match(url);
  if (cached) return cached.clone();
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`offline style asset unavailable: ${url} (${response.status})`);
  await cache?.put(url, response.clone());
  return response;
}

async function fetchOptionalPinned(
  url: string,
  manifest: OfflineMapPackageManifest,
): Promise<void> {
  const cache = await openStyleCache(manifest);
  if (await cache?.match(url)) return;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (response.ok) await cache?.put(url, response.clone());
  } catch {
    // High-density sprite variants are optional in the source style bundle.
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

function glyphUrls(template: string, stacks: string[]): string[] {
  return stacks.flatMap((stack) =>
    GLYPH_RANGES.map((range) =>
      template.replace("{fontstack}", encodeURIComponent(stack)).replace("{range}", range),
    ),
  );
}

export async function validateOfflineStyleAssets(
  manifest: OfflineMapPackageManifest,
): Promise<OfflinePackageStyleAssets> {
  if (manifest.style.provider !== "openmapx") {
    throw new Error("only OpenMapX styles can be used by an OpenMapX package");
  }
  const loaded = {} as OfflinePackageStyleAssets;
  const variants = ["light", "dark"] as const;
  for (const variant of variants) {
    const response = await fetchPinned(styleUrl(manifest, variant), manifest);
    const style = (await response.json()) as StyleJson;
    if (!style.sources?.openmaptiles)
      throw new Error(`OpenMapX ${variant} style has no vector source`);
    for (const source of Object.values(style.sources)) {
      if (source && typeof source === "object" && "attribution" in source) source.attribution = "";
    }

    if (typeof style.glyphs !== "string") {
      throw new Error(`OpenMapX ${variant} style has no glyph template`);
    }
    for (const url of glyphUrls(glyphTemplate(manifest), fontStacks(style))) {
      await fetchPinned(url, manifest);
    }
    const base = spriteBaseUrl(manifest, variant);
    await fetchPinned(`${base}.json`, manifest);
    await fetchPinned(`${base}.png`, manifest);
    await fetchOptionalPinned(`${base}@2x.json`, manifest);
    await fetchOptionalPinned(`${base}@2x.png`, manifest);
    if (!style.sprite) {
      throw new Error(`OpenMapX ${variant} style has no sprite template`);
    }
    loaded[variant] = style;
  }
  loaded.manifest = manifest;
  return loaded;
}

export async function resolveOfflinePackageStyle(
  manifest: OfflineMapPackageManifest,
  packageId: string,
  variant: "light" | "dark",
): Promise<Record<string, unknown>> {
  const response = await fetchPinned(styleUrl(manifest, variant), manifest);
  const style = (await response.json()) as StyleJson;
  const source = style.sources?.openmaptiles;
  if (!source) throw new Error("OpenMapX style has no openmaptiles source");
  source.tiles = [offlinePmtilesTileUrl(packageId)];
  delete source.url;
  source.attribution = "";
  style.glyphs = glyphTemplate(manifest);
  style.sprite = spriteBaseUrl(manifest, variant);
  return style;
}

export function offlineStyleCacheName(manifest: OfflineMapPackageManifest): string {
  return cacheName(manifest);
}
