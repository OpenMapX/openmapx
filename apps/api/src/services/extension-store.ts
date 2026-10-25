import { createHash } from "node:crypto";
import { USER_AGENT_ADMIN, validatePublicUrl } from "@openmapx/core";
import {
  assertAllowedGitUrl,
  services as coreServices,
  safeFetchJson,
  safeFetchText,
} from "@openmapx/core/server";
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
import {
  editExtensionSources,
  publishExtensionCatalog,
  readExtensionSnapshot,
  repairExtensionUrlState,
} from "./extension-store-cache";
import { ExtensionStoreError } from "./extension-store-error";

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
  /** maxVersion is advisory display data; every critical entry denies execution. */
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

const catalogKeys = { sources: EXTRA_SOURCES_CACHE_KEY, catalog: CATALOG_CACHE_KEY };

function cachedCatalogNeedsLocatorRepair(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    const cached = JSON.parse(raw) as { entries?: unknown };
    if (!Array.isArray(cached.entries)) return true;
    return cached.entries.some((entry) => {
      if (!isCatalogRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string")
        return true;
      try {
        const normalized = normalizeCatalogEntry(entry as unknown as ExtensionCatalogEntry);
        return (
          normalized.manifest !== entry.manifest ||
          JSON.stringify(normalized.services) !== JSON.stringify(entry.services) ||
          JSON.stringify(normalized.integrations) !== JSON.stringify(entry.integrations)
        );
      } catch {
        return true;
      }
    });
  } catch {
    return true;
  }
}

/** Remove legacy secret-bearing Redis locators before the API starts serving. */
export async function scrubExtensionStoreUrlState(): Promise<void> {
  if (!redis) return;
  const { raw, sources } = await getExtraSources();
  const catalogRaw = await readExtensionSnapshot(redis, CATALOG_CACHE_KEY);
  let sourcesChanged = false;
  const repairedSources: ExtensionCatalogSource[] = [];
  for (const source of sources) {
    try {
      const canonical = normalizeExtensionLocator(source.url);
      validatePublicUrl(canonical);
      repairedSources.push({ ...source, url: canonical });
      if (canonical !== source.url) sourcesChanged = true;
    } catch {
      sourcesChanged = true;
    }
  }
  if (!sourcesChanged && !cachedCatalogNeedsLocatorRepair(catalogRaw)) return;
  await repairExtensionUrlState(
    redis,
    catalogKeys,
    raw,
    catalogRaw,
    JSON.stringify(repairedSources),
  );
}

async function getExtraSources(): Promise<{
  raw: string | null;
  sources: ExtensionCatalogSource[];
}> {
  // Without configured persistence, read-only discovery retains the default source.
  const raw = redis ? await readExtensionSnapshot(redis, EXTRA_SOURCES_CACHE_KEY) : null;
  if (raw === null) return { raw, sources: [] };
  try {
    const sources: unknown = JSON.parse(raw);
    if (
      !Array.isArray(sources) ||
      !sources.every(
        (source) =>
          source !== null &&
          typeof source === "object" &&
          typeof source.url === "string" &&
          typeof source.label === "string" &&
          source.isDefault === false,
      )
    )
      throw new Error();
    // Preserve inert fields and exact observed bytes; do not normalize the CAS input.
    return { raw, sources };
  } catch {
    throw new ExtensionStoreError("invalid_source_snapshot");
  }
}

function withDefaultSource(sources: ExtensionCatalogSource[]): ExtensionCatalogSource[] {
  let canonical: string;
  try {
    canonical = normalizeExtensionLocator(DEFAULT_EXTENSION_CATALOG_URL);
    validatePublicUrl(canonical);
  } catch {
    throw new ExtensionStoreError("invalid_source_url");
  }
  return [{ url: canonical, label: "OpenMapX Community", isDefault: true }, ...sources];
}

export async function addExtensionSource(url: string, label: string): Promise<void> {
  let canonical: string;
  try {
    canonical = normalizeExtensionLocator(url);
    validatePublicUrl(canonical);
  } catch {
    throw new ExtensionStoreError("invalid_source_url");
  }
  if (!redis) throw new ExtensionStoreError("source_storage_unavailable");
  const { raw, sources } = await getExtraSources();
  if (sources.some((s) => s.url === canonical)) return;
  await editExtensionSources(
    redis,
    catalogKeys,
    raw,
    JSON.stringify([...sources, { url: canonical, label, isDefault: false }]),
  );
}

export async function removeExtensionSource(url: string): Promise<void> {
  if (!redis) throw new ExtensionStoreError("source_storage_unavailable");
  const { raw, sources } = await getExtraSources();
  if (!sources.some((s) => s.url === url)) return;
  await editExtensionSources(
    redis,
    catalogKeys,
    raw,
    JSON.stringify(sources.filter((s) => s.url !== url)),
  );
}

export async function listExtensionSources(): Promise<ExtensionCatalogSource[]> {
  return withDefaultSource((await getExtraSources()).sources);
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

function isCatalogRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCatalogEntryList(value: unknown): value is ExtensionCatalogEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isCatalogRecord(entry) && typeof entry.id === "string" && typeof entry.name === "string",
    )
  );
}

function normalizeCatalogEntry(entry: ExtensionCatalogEntry): ExtensionCatalogEntry {
  const normalized: ExtensionCatalogEntry = { ...entry };
  if (entry.manifest !== undefined) {
    if (typeof entry.manifest !== "string")
      throw new ExtensionStoreError("catalog_acquisition_failed");
    normalized.manifest = normalizeExtensionLocator(entry.manifest);
  }
  if (entry.services !== undefined) {
    if (!Array.isArray(entry.services)) throw new ExtensionStoreError("catalog_acquisition_failed");
    normalized.services = entry.services.map((service) => {
      const parsed = coreServices.extensionManifestSchema.shape.services
        .unwrap()
        .element.safeParse(service);
      if (!parsed.success || !isCatalogRecord(service)) {
        throw new ExtensionStoreError("catalog_acquisition_failed");
      }
      return { ...service, repo: assertAllowedGitUrl(parsed.data.repo).canonical };
    });
  }
  if (entry.integrations !== undefined) {
    if (!Array.isArray(entry.integrations)) {
      throw new ExtensionStoreError("catalog_acquisition_failed");
    }
    normalized.integrations = entry.integrations.map((integration) => {
      const parsed = coreServices.extensionManifestSchema.shape.integrations
        .unwrap()
        .element.safeParse(integration);
      if (!parsed.success || !isCatalogRecord(integration)) {
        throw new ExtensionStoreError("catalog_acquisition_failed");
      }
      return {
        ...integration,
        artifact: coreServices.canonicalExtensionLocator(parsed.data.artifact),
      };
    });
  }
  return normalized;
}

function isCatalogControlList(value: unknown, critical: boolean): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isCatalogRecord(entry) &&
        typeof entry.id === "string" &&
        (!Object.hasOwn(entry, "reason") || typeof entry.reason === "string") &&
        (!critical || !Object.hasOwn(entry, "maxVersion") || typeof entry.maxVersion === "string"),
    )
  );
}

async function fetchCatalogFromUrl(url: string): Promise<FetchedCatalog> {
  let canonical: string;
  try {
    canonical = normalizeExtensionLocator(url);
    validatePublicUrl(canonical);
  } catch {
    throw new ExtensionStoreError("catalog_acquisition_failed");
  }
  const data = await safeFetchJson<unknown>(canonical, {
    headers: { "User-Agent": USER_AGENT_ADMIN },
    timeoutMs: 15_000,
  });
  // Accept either a bare array of entries or `{ extensions, removed, critical }`.
  // Validate the whole document before consuming it: malformed acquisition is
  // not evidence of an empty catalog, and must not clear cached denials.
  if (Array.isArray(data)) {
    if (!isCatalogEntryList(data)) throw new ExtensionStoreError("catalog_acquisition_failed");
    return { entries: data.map(normalizeCatalogEntry), control: {} };
  }
  if (
    !isCatalogRecord(data) ||
    (Object.hasOwn(data, "extensions") && !isCatalogEntryList(data.extensions)) ||
    (Object.hasOwn(data, "removed") && !isCatalogControlList(data.removed, false)) ||
    (Object.hasOwn(data, "critical") && !isCatalogControlList(data.critical, true))
  ) {
    throw new ExtensionStoreError("catalog_acquisition_failed");
  }
  const obj = data as { extensions?: ExtensionCatalogEntry[] } & CatalogControl;
  return {
    entries: (obj.extensions ?? []).map(normalizeCatalogEntry),
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

async function buildCatalog(sources: ExtensionCatalogSource[]): Promise<CachedCatalog> {
  let acquisitionFailed = false;
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
      acquisitionFailed = true;
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

  // A failed acquisition is not evidence that a catalog is empty. Preserve the
  // existing nonempty partial-build behavior and independent revocation feed.
  if (acquisitionFailed && entries.length === 0) {
    throw new ExtensionStoreError("catalog_acquisition_failed");
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
  if (forceRefresh && !redis) throw new ExtensionStoreError("source_storage_unavailable");
  const snapshot = await getExtraSources();
  const observedCatalog = redis ? await readExtensionSnapshot(redis, CATALOG_CACHE_KEY) : null;
  if (!forceRefresh && observedCatalog !== null) {
    try {
      const cached = JSON.parse(observedCatalog) as CachedCatalog;
      if (
        !Array.isArray(cached.entries) ||
        !cached.entries.every(
          (entry) => entry && typeof entry.id === "string" && typeof entry.name === "string",
        ) ||
        !Array.isArray(cached.killSwitch.removed) ||
        !cached.killSwitch.removed.every(
          (item) =>
            Array.isArray(item) &&
            item.length === 2 &&
            typeof item[0] === "string" &&
            typeof item[1] === "string",
        ) ||
        !Array.isArray(cached.killSwitch.critical) ||
        !cached.killSwitch.critical.every(
          (item) =>
            Array.isArray(item) &&
            item.length === 2 &&
            typeof item[0] === "string" &&
            item[1] &&
            typeof item[1].reason === "string" &&
            (item[1].maxVersion === undefined || typeof item[1].maxVersion === "string"),
        )
      ) {
        throw new Error();
      }
      return cached;
    } catch {
      throw new ExtensionStoreError("invalid_catalog_snapshot");
    }
  }
  const built = await buildCatalog(withDefaultSource(snapshot.sources));
  if (redis) {
    // Await acknowledgement, including valid empty builds. A rejected publish
    // never returns the obsolete build as current; callers may deliberately read again.
    await publishExtensionCatalog(
      redis,
      catalogKeys,
      snapshot.raw,
      observedCatalog,
      JSON.stringify(built),
      CATALOG_CACHE_TTL,
    );
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
    const text = await safeFetchText(normalizeExtensionLocator(entry.manifest), {
      headers: { "User-Agent": USER_AGENT_ADMIN },
      timeoutMs: 15_000,
    });
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    if (digest !== entry.manifestSha256.toLowerCase()) {
      throw new ExtensionStoreError("digest_mismatch");
    }
    raw = JSON.parse(text) as unknown;
  } else if (entry.manifest) {
    if (entry.trust === "verified") {
      throw new ExtensionStoreError("missing_digest");
    }
    raw = await safeFetchJson<unknown>(normalizeExtensionLocator(entry.manifest), {
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
  const manifest = validatedManifest(raw);
  // The catalog entry and the manifest must describe the same thing. Without
  // this, an entry could authorize one id/version and install another.
  if (manifest.id !== entry.id) {
    throw new ExtensionStoreError("id_mismatch");
  }
  if (entry.version && manifest.version !== entry.version) {
    throw new ExtensionStoreError("version_mismatch");
  }
  return manifest;
}

function validatedManifest(raw: unknown): ExtensionManifest {
  const parsed = coreServices.extensionManifestSchema.safeParse(raw);
  if (!parsed.success) throw new ExtensionStoreError("invalid_manifest");
  try {
    return {
      ...parsed.data,
      services: parsed.data.services?.map((service) => ({
        ...service,
        repo: assertAllowedGitUrl(service.repo).canonical,
      })),
      integrations: parsed.data.integrations?.map((integration) => ({
        ...integration,
        artifact: coreServices.canonicalExtensionLocator(integration.artifact),
      })),
    };
  } catch {
    throw new ExtensionStoreError("invalid_manifest");
  }
}

export function normalizeExtensionLocator(url: string): string {
  try {
    return coreServices.canonicalExtensionLocator(url);
  } catch {
    throw new ExtensionStoreError("invalid_manifest");
  }
}

/** Direct content has no catalog authorization to bind against or trust to inherit. */
export async function resolveDirectExtensionManifest(url: string): Promise<ExtensionManifest> {
  const raw = await safeFetchJson<unknown>(normalizeExtensionLocator(url), {
    headers: { "User-Agent": USER_AGENT_ADMIN },
    timeoutMs: 15_000,
  });
  return validatedManifest(raw);
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
