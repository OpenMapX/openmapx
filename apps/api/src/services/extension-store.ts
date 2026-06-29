import { USER_AGENT_ADMIN, validatePublicUrl } from "@openmapx/core";
import { services as coreServices } from "@openmapx/core/server";
import { PLATFORM_VERSION, satisfiesPlatformVersion } from "@openmapx/integration-framework";
import { db } from "../db";
import {
  type InstalledExtensionRow,
  installedExtension,
  installedExtensionComponent,
} from "../db/schema";
import { redis } from "../redis";
import { envString } from "../utils/env.js";

type ExtensionManifest = coreServices.ExtensionManifest;
type ExtensionTrust = "built-in" | "verified" | "community";

// The curated OpenMapX catalog (verified tier). CI-gated PR inclusion is the
// identity/validation gate; entries from any other (operator-added) source are
// surfaced as the lower "community" tier.
const DEFAULT_EXTENSION_CATALOG_URL = envString(
  "EXTENSION_CATALOG_URL",
  "https://raw.githubusercontent.com/openmapx/community-extensions/main/catalog.json",
);

const CATALOG_CACHE_KEY = "extstore:catalog";
const CATALOG_CACHE_TTL = 60 * 60 * 24; // 24h
const EXTRA_SOURCES_CACHE_KEY = "extstore:extra_sources";

export interface ExtensionCatalogEntry {
  id: string;
  name: string;
  summary?: string;
  description?: string;
  author?: string;
  homepage?: string;
  icon?: string;
  screenshots?: string[];
  categories?: string[];
  tags?: string[];
  version: string;
  minPlatform?: string;
  lastUpdated?: string;
  /** URL of the authoritative extension.json (the components to install). */
  manifest?: string;
  /** Inline components (alternative to a separate manifest file). */
  services?: ExtensionManifest["services"];
  integrations?: ExtensionManifest["integrations"];
  /** Editorial highlight, orthogonal to the trust tier. */
  featured?: boolean;
  /** Filled in by the resolver — never trusted from the document itself. */
  trust?: ExtensionTrust;
}

/** Kill-switch + delisting carried by a catalog document. */
interface CatalogControl {
  removed?: Array<{ id: string; reason?: string }>;
  critical?: Array<{ id: string; reason?: string; maxVersion?: string }>;
}

export interface ExtensionCatalogSource {
  url: string;
  label: string;
  isDefault: boolean;
}

export interface KillSwitch {
  removed: Map<string, string>; // id -> reason
  critical: Map<string, { reason: string; maxVersion?: string }>;
}

async function getExtraSources(): Promise<ExtensionCatalogSource[]> {
  if (!redis) return [];
  try {
    const raw = await redis.get(EXTRA_SOURCES_CACHE_KEY);
    return raw ? (JSON.parse(raw) as ExtensionCatalogSource[]) : [];
  } catch {
    return [];
  }
}

export async function addExtensionSource(url: string, label: string): Promise<void> {
  if (!redis) throw new Error("Redis unavailable — cannot persist catalog sources");
  validatePublicUrl(url);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Catalog source must use HTTPS");
  if (parsed.username || parsed.password) {
    throw new Error("Catalog source URL must not contain credentials");
  }
  const existing = await getExtraSources();
  if (existing.some((s) => s.url === url)) return;
  existing.push({ url, label, isDefault: false });
  await redis.set(EXTRA_SOURCES_CACHE_KEY, JSON.stringify(existing));
}

export async function removeExtensionSource(url: string): Promise<void> {
  if (!redis) return;
  const existing = await getExtraSources();
  await redis.set(EXTRA_SOURCES_CACHE_KEY, JSON.stringify(existing.filter((s) => s.url !== url)));
}

export async function listExtensionSources(): Promise<ExtensionCatalogSource[]> {
  return [
    { url: DEFAULT_EXTENSION_CATALOG_URL, label: "OpenMapX Community", isDefault: true },
    ...(await getExtraSources()),
  ];
}

function trustForSource(isDefault: boolean): ExtensionTrust {
  return isDefault ? "verified" : "community";
}

interface FetchedCatalog {
  entries: ExtensionCatalogEntry[];
  control: CatalogControl;
}

async function fetchCatalogFromUrl(url: string): Promise<FetchedCatalog> {
  validatePublicUrl(url);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT_ADMIN },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Catalog fetch failed: HTTP ${res.status}`);
  const data = (await res.json()) as unknown;
  // Accept either a bare array of entries or `{ extensions, removed, critical }`.
  if (Array.isArray(data)) {
    return { entries: data as ExtensionCatalogEntry[], control: {} };
  }
  const obj = data as { extensions?: ExtensionCatalogEntry[] } & CatalogControl;
  return {
    entries: Array.isArray(obj.extensions) ? obj.extensions : [],
    control: { removed: obj.removed, critical: obj.critical },
  };
}

/**
 * Fetch the live `{ version, platform }` from an extension's manifest URL — the
 * source of truth for "what is currently published". Returns null on any failure
 * so the catalog build falls back to the entry's declared values.
 *
 * This is what lets a catalog entry whose `manifest` points at a MOVING url
 * (e.g. `…/releases/latest/download/extension.json`) track the source's latest
 * release without a catalog edit per release — see {@link applyLiveVersions}.
 */
export async function fetchManifestMeta(
  url: string,
): Promise<{ version?: string; platform?: string } | null> {
  try {
    validatePublicUrl(url);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT_ADMIN },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown; platform?: unknown };
    return {
      version: typeof data.version === "string" && data.version ? data.version : undefined,
      platform: typeof data.platform === "string" && data.platform ? data.platform : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Override each catalog entry's `version`/`minPlatform` with the live values from
 * its `manifest` URL, so an entry pointing `manifest` at a moving "latest release"
 * url surfaces a new release as an available update with no catalog change.
 * Entries without a `manifest` url (inline components) keep their declared values;
 * a fetch failure also falls back to the declared values. Mutates `entries` in
 * place; runs the fetches concurrently. `fetchMeta` is injectable for tests.
 */
export async function applyLiveVersions(
  entries: ExtensionCatalogEntry[],
  fetchMeta: (
    url: string,
  ) => Promise<{ version?: string; platform?: string } | null> = fetchManifestMeta,
): Promise<void> {
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.manifest) return;
      const meta = await fetchMeta(entry.manifest);
      if (meta?.version) entry.version = meta.version;
      if (meta?.platform) entry.minPlatform = meta.platform;
    }),
  );
}

interface CachedCatalog {
  entries: ExtensionCatalogEntry[];
  killSwitch: {
    removed: [string, string][];
    critical: [string, { reason: string; maxVersion?: string }][];
  };
}

async function buildCatalog(): Promise<CachedCatalog> {
  const sources = await listExtensionSources();
  const entries: ExtensionCatalogEntry[] = [];
  const seen = new Set<string>();
  const removed: [string, string][] = [];
  const critical: [string, { reason: string; maxVersion?: string }][] = [];

  for (const source of sources) {
    try {
      const { entries: fetched, control } = await fetchCatalogFromUrl(source.url);
      const trust = trustForSource(source.isDefault);
      for (const entry of fetched) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push({ ...entry, trust });
      }
      for (const r of control.removed ?? []) removed.push([r.id, r.reason ?? "delisted"]);
      for (const c of control.critical ?? []) {
        critical.push([
          c.id,
          { reason: c.reason ?? "security advisory", maxVersion: c.maxVersion },
        ]);
      }
    } catch (err) {
      console.warn(`[extstore] Failed to fetch catalog from ${source.url}:`, err);
    }
  }

  // The catalog's declared `version` is only a fallback — the manifest URL is the
  // source of truth. An entry pointing `manifest` at a moving "latest release"
  // url therefore surfaces new releases without a catalog edit per release.
  await applyLiveVersions(entries);

  return { entries, killSwitch: { removed, critical } };
}

export async function getExtensionCatalog(forceRefresh = false): Promise<ExtensionCatalogEntry[]> {
  return (await getCatalogCached(forceRefresh)).entries;
}

export async function getKillSwitch(): Promise<KillSwitch> {
  const cached = await getCatalogCached(false);
  return {
    removed: new Map(cached.killSwitch.removed),
    critical: new Map(cached.killSwitch.critical),
  };
}

async function getCatalogCached(forceRefresh: boolean): Promise<CachedCatalog> {
  if (!forceRefresh && redis) {
    try {
      const cached = await redis.get(CATALOG_CACHE_KEY);
      if (cached) return JSON.parse(cached) as CachedCatalog;
    } catch {
      // miss
    }
  }
  const built = await buildCatalog();
  if (redis && built.entries.length > 0) {
    redis.setex(CATALOG_CACHE_KEY, CATALOG_CACHE_TTL, JSON.stringify(built)).catch(() => {});
  }
  return built;
}

export async function getExtensionCatalogEntry(id: string): Promise<ExtensionCatalogEntry | null> {
  return (await getExtensionCatalog()).find((e) => e.id === id) ?? null;
}

/**
 * Resolve a catalog entry to a concrete, validated `extension.json` manifest:
 * fetch the linked manifest file, or assemble one from the entry's inline
 * service/integration components.
 */
export async function resolveExtensionManifest(
  entry: ExtensionCatalogEntry,
): Promise<ExtensionManifest> {
  let raw: unknown;
  if (entry.manifest) {
    validatePublicUrl(entry.manifest);
    const res = await fetch(entry.manifest, {
      headers: { "User-Agent": USER_AGENT_ADMIN },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`extension.json fetch failed: HTTP ${res.status}`);
    raw = await res.json();
  } else {
    raw = {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      platform: entry.minPlatform,
      services: entry.services,
      integrations: entry.integrations,
    };
  }
  const validation = coreServices.validateExtensionManifest(raw);
  if (!validation.valid) {
    throw new Error(`Invalid extension.json for "${entry.id}": ${validation.errors.join("; ")}`);
  }
  return raw as ExtensionManifest;
}

export function isExtensionCompatible(entry: ExtensionCatalogEntry): boolean {
  if (!entry.minPlatform) return true;
  return satisfiesPlatformVersion(entry.minPlatform);
}

export interface InstalledExtensionView extends InstalledExtensionRow {
  components: Array<{ kind: string; componentId: string }>;
}

export async function listInstalledExtensions(): Promise<InstalledExtensionView[]> {
  const rows = await db.select().from(installedExtension);
  const comps = await db.select().from(installedExtensionComponent);
  const byExt = new Map<string, Array<{ kind: string; componentId: string }>>();
  for (const c of comps) {
    const arr = byExt.get(c.extensionId) ?? [];
    arr.push({ kind: c.kind, componentId: c.componentId });
    byExt.set(c.extensionId, arr);
  }
  return rows.map((r) => ({ ...r, components: byExt.get(r.id) ?? [] }));
}

export { PLATFORM_VERSION };
