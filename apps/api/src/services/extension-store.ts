import { createHash } from "node:crypto";
import { USER_AGENT_ADMIN, validatePublicUrl } from "@openmapx/core";
import { services as coreServices, safeFetchJson, safeFetchText } from "@openmapx/core/server";
import { envString } from "@openmapx/core/server-env";
import { PLATFORM_VERSION, satisfiesPlatformVersion } from "@openmapx/integration-framework";
import { db } from "../db";
import {
  type InstalledExtensionRow,
  installedExtension,
  installedExtensionComponent,
} from "../db/schema";
import { redis } from "../redis";
import { safeErrorClass, summarizeExternalUrl } from "../utils/safe-log-fields.js";
import { appLogger } from "./app-logger.js";

type ExtensionManifest = coreServices.ExtensionManifest;
type ExtensionTrust = "built-in" | "verified" | "community";

// The curated OpenMapX catalog. Verified trust is NOT granted by being this
// source: it comes from immutable content only. The default is pinned to an
// exact commit so the catalog bytes cannot move under us, and each entry still
// has to be digest-bound (see `resolveEntryTrust`) to reach the verified tier.
// Resolved with `git ls-remote https://github.com/openmapx/community-extensions.git
// refs/heads/main` on 2026-08-25.
const DEFAULT_EXTENSION_CATALOG_COMMIT = "254ed34c34f204809870323e7dca6389e0d6f81f";
const DEFAULT_EXTENSION_CATALOG_URL = envString(
  "EXTENSION_CATALOG_URL",
  `https://raw.githubusercontent.com/openmapx/community-extensions/${DEFAULT_EXTENSION_CATALOG_COMMIT}/catalog.json`,
);

// A moving deny-only feed. It may disable extensions but can never add one,
// change a manifest, raise trust, or select an upgrade.
const EXTENSION_REVOCATION_FEED_URL = envString(
  "EXTENSION_REVOCATION_URL",
  "https://raw.githubusercontent.com/openmapx/community-extensions/main/revocations.json",
);

const COMMIT_PATH_SEGMENT = /(^|\/)[a-f0-9]{40}(\/|$)/;

/**
 * True when the catalog URL names an exact 40-hex commit. A branch or tag URL
 * can be repointed at new bytes by whoever controls the ref, so it can never
 * carry verified trust.
 */
export function isImmutableCatalogUrl(url: string): boolean {
  try {
    return COMMIT_PATH_SEGMENT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

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
  /**
   * Developer-controlled, NOT authored in the catalog: resolved live from the
   * entry's `manifest` (see {@link applyLiveVersions}). Optional so the catalog
   * doesn't carry — and the catalog manager doesn't maintain — a version. Only
   * inline entries (no `manifest`) declare it directly. Undefined only when a
   * manifest entry's fetch fails with no declared fallback.
   */
  version?: string;
  /** Developer-controlled — resolved from the manifest's `platform` (fallback only if declared). */
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
  /**
   * Exact SHA-256 of the manifest bytes this entry authorizes. Present only on
   * verified entries; it is what makes the entry immutable.
   */
  manifestSha256?: string;
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
  /**
   * True when the moving revocation feed could not be refreshed and the last
   * known-good snapshot is being served instead. Administrators must be able to
   * tell "nothing is revoked" from "we could not check".
   */
  stale: boolean;
}

const REVOCATION_CACHE_KEY = "extstore:revocations";
const REVOCATION_CACHE_TTL = 60 * 60 * 24 * 30; // keep the last good snapshot for 30 days

interface RevocationSnapshot {
  removed: [string, string][];
  critical: [string, { reason: string; maxVersion?: string }][];
  fetchedAtMs: number;
}

/**
 * Fetch the moving deny-only feed. It is parsed with a deny-only shape: there is
 * deliberately no path by which it can introduce an entry, alter a manifest,
 * raise trust, or select a version. On failure the last valid snapshot is
 * reused and reported as stale rather than silently becoming "nothing revoked".
 */
async function fetchRevocations(): Promise<{ snapshot: RevocationSnapshot; stale: boolean }> {
  const cached = await readCachedRevocations();
  try {
    const data = await safeFetchJson<unknown>(EXTENSION_REVOCATION_FEED_URL, {
      headers: { "User-Agent": USER_AGENT_ADMIN },
      timeoutMs: 15_000,
    });
    const control = (data ?? {}) as CatalogControl;
    const snapshot: RevocationSnapshot = {
      removed: (control.removed ?? [])
        .filter((r) => typeof r?.id === "string")
        .map((r) => [r.id, typeof r.reason === "string" ? r.reason : "delisted"]),
      critical: (control.critical ?? [])
        .filter((c) => typeof c?.id === "string")
        .map((c) => [
          c.id,
          {
            reason: typeof c.reason === "string" ? c.reason : "security advisory",
            ...(typeof c.maxVersion === "string" ? { maxVersion: c.maxVersion } : {}),
          },
        ]),
      fetchedAtMs: Date.now(),
    };
    if (redis) {
      redis
        .setex(REVOCATION_CACHE_KEY, REVOCATION_CACHE_TTL, JSON.stringify(snapshot))
        .catch(() => {});
    }
    return { snapshot, stale: false };
  } catch (err) {
    appLogger.add({
      level: "warn",
      source: "extension-store",
      msg: "Extension revocation feed refresh failed; serving last known snapshot",
      time: Date.now(),
      metadata: {
        revocationSource: summarizeExternalUrl(EXTENSION_REVOCATION_FEED_URL),
        errorClass: safeErrorClass(err),
      },
    });
    return {
      snapshot: cached ?? { removed: [], critical: [], fetchedAtMs: 0 },
      stale: true,
    };
  }
}

async function readCachedRevocations(): Promise<RevocationSnapshot | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(REVOCATION_CACHE_KEY);
    return raw ? (JSON.parse(raw) as RevocationSnapshot) : null;
  } catch {
    return null;
  }
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

/**
 * Verified trust requires immutable content, never provenance. An entry earns
 * it only when it comes from the default catalog resolved at an exact commit
 * AND the entry itself is digest-bound to exact manifest bytes. Everything else
 * — a custom source, a moving default, or an entry without a manifest digest —
 * is community trust.
 */
export function resolveEntryTrust(
  source: ExtensionCatalogSource,
  entry: unknown,
): { trust: ExtensionTrust; verified?: coreServices.VerifiedCatalogEntry } {
  if (!source.isDefault || !isImmutableCatalogUrl(source.url)) return { trust: "community" };
  const parsed = coreServices.verifiedCatalogEntrySchema.safeParse(
    pickVerifiedFields(entry as Record<string, unknown>),
  );
  return parsed.success ? { trust: "verified", verified: parsed.data } : { trust: "community" };
}

// The verified schema is strict so a feed cannot smuggle extra trust inputs.
// Editorial fields (name, icon, tags) are presentation only and are checked
// separately, so they are not part of the authorization decision.
function pickVerifiedFields(entry: Record<string, unknown>) {
  return {
    id: entry.id,
    version: entry.version,
    manifest: entry.manifest,
    manifestSha256: entry.manifestSha256,
    ...(entry.platform === undefined ? {} : { platform: entry.platform }),
  };
}

interface FetchedCatalog {
  entries: ExtensionCatalogEntry[];
  control: CatalogControl;
}

async function fetchCatalogFromUrl(url: string): Promise<FetchedCatalog> {
  const data = await safeFetchJson<unknown>(url, {
    headers: { "User-Agent": USER_AGENT_ADMIN },
    timeoutMs: 15_000,
  });
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
    const data = await safeFetchJson<{ version?: unknown; platform?: unknown }>(url, {
      headers: { "User-Agent": USER_AGENT_ADMIN },
      timeoutMs: 15_000,
    });
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
      // A verified entry is pinned to exact manifest bytes by the immutable
      // catalog. Letting a moving manifest URL choose its version would hand
      // version selection — and therefore what gets installed — back to a
      // source that can change at any time.
      if (entry.trust === "verified") return;
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
      for (const entry of fetched) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        const resolved = resolveEntryTrust(source, entry);
        entries.push({
          ...entry,
          trust: resolved.trust,
          // A verified entry's authorized version and digest come from the
          // immutable catalog bytes, not from whatever the manifest URL
          // currently serves.
          ...(resolved.verified
            ? {
                version: resolved.verified.version,
                minPlatform: resolved.verified.platform,
                manifestSha256: resolved.verified.manifestSha256,
              }
            : {}),
        });
      }
      for (const r of control.removed ?? []) removed.push([r.id, r.reason ?? "delisted"]);
      for (const c of control.critical ?? []) {
        critical.push([
          c.id,
          { reason: c.reason ?? "security advisory", maxVersion: c.maxVersion },
        ]);
      }
    } catch (err) {
      appLogger.add({
        level: "warn",
        source: "extension-store",
        msg: "Extension catalog fetch failed",
        time: Date.now(),
        metadata: {
          catalogSource: summarizeExternalUrl(source.url),
          errorClass: safeErrorClass(err),
        },
      });
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
  const revocations = await fetchRevocations();
  // Union of the catalog's own control block and the moving deny-only feed.
  // Both can only ADD denials.
  const removed = new Map(cached.killSwitch.removed);
  const critical = new Map(cached.killSwitch.critical);
  for (const [id, reason] of revocations.snapshot.removed) removed.set(id, reason);
  for (const [id, value] of revocations.snapshot.critical) critical.set(id, value);
  return { removed, critical, stale: revocations.stale };
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
  if (entry.manifest && entry.manifestSha256) {
    // Verify the digest over the exact received bytes BEFORE they are parsed or
    // cached. Parsing first would expose the parser to unverified content and
    // would let a cache hold bytes that were never authorized.
    const text = await safeFetchText(entry.manifest, {
      headers: { "User-Agent": USER_AGENT_ADMIN },
      timeoutMs: 15_000,
    });
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    if (digest !== entry.manifestSha256.toLowerCase()) {
      throw new Error(`Extension manifest digest mismatch for "${entry.id}"`);
    }
    raw = JSON.parse(text) as unknown;
  } else if (entry.manifest) {
    if (entry.trust === "verified") {
      throw new Error(`Verified extension "${entry.id}" is missing its manifest digest`);
    }
    raw = await safeFetchJson<unknown>(entry.manifest, {
      headers: { "User-Agent": USER_AGENT_ADMIN },
      timeoutMs: 15_000,
    });
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
  const manifest = raw as ExtensionManifest;
  // The catalog entry and the manifest must describe the same thing. Without
  // this, an entry could authorize one id/version and install another.
  if (manifest.id !== entry.id) {
    throw new Error(`Extension manifest id does not match catalog entry "${entry.id}"`);
  }
  if (entry.version && manifest.version !== entry.version) {
    throw new Error(`Extension manifest version does not match catalog entry "${entry.id}"`);
  }
  return manifest;
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
