import { safeFetchJson } from "@openmapx/core/server";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { parseGofsDiscovery } from "@openmapx/mobility-formats";
import { applyGofsAuth, type GofsFetchJson } from "./feed.js";
import supplement from "./systems.supplement.json" with { type: "json" };
import type { GofsAuth, GofsFeedConfig } from "./types.js";

/**
 * MobilityData's GOFS registry — the GBFS-style `systems.json`. Tracked from
 * `main` rather than pinned: probe-before-offer already contains the blast
 * radius of a bad row, and pinning would mean a release for every new system.
 */
const UPSTREAM_URL = "https://raw.githubusercontent.com/MobilityData/GOFS/main/systems.json";
const CATALOG_CACHE_KEY = "gofs:catalog:upstream";
const CATALOG_TTL_SECONDS = 6 * 3600;
const PROBE_TTL_SECONDS = 3600;

/** The registry's own column names, which are human-readable and space-separated. */
interface UpstreamSystem {
  "Country Code"?: string;
  Name?: string;
  Location?: string;
  "Access Information"?: string | null;
  URL?: string;
  "Supported Versions"?: unknown;
}

export type CatalogOrigin = "upstream" | "supplement" | "operator";
export type CatalogStatus = "live" | "credential-required" | "unavailable";

export interface CatalogEntry extends GofsFeedConfig {
  origin: CatalogOrigin;
  countryCode?: string;
  location?: string;
  /** Where to go to obtain access, for feeds that need a credential. */
  accessInformation?: string;
  status: CatalogStatus;
}

/**
 * Feeds we ship named support for that require a credential, bound to the
 * `dataSources[].sourceId` their key composes against and to the auth scheme
 * they expect. Adding another named keyed feed is a row here plus a manifest
 * data source, a credential field and its privacy strings.
 *
 * `id` is the slug the catalog derives from the registry's `Name` column, so
 * a match here activates automatically when the entry appears upstream.
 */
export const KEYED_FEEDS: ReadonlyArray<{
  id: string;
  sourceId: string;
  auth: { kind: "header" | "query"; name: string };
}> = [
  {
    id: "taxi-montreal",
    sourceId: "ca-taxi-montreal",
    auth: { kind: "header", name: "X-API-KEY" },
  },
];

/** Generic slots so an operator can key a feed we do not ship support for. */
const CUSTOM_SLOTS: readonly number[] = [1, 2, 3];

/** `Freebee Miami Beach` → `freebee-miami-beach`. */
function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isUsableUrl(value: string | undefined): value is string {
  if (!value) return false;
  // The registry uses "forthcoming" as a placeholder for a system that has
  // committed to publishing but has not yet.
  return /^https?:\/\//.test(value);
}

function toEntry(system: UpstreamSystem, origin: CatalogOrigin): CatalogEntry | null {
  const name = system.Name?.trim();
  if (!name || !isUsableUrl(system.URL)) return null;
  return {
    id: slugify(name),
    name,
    url: system.URL,
    origin,
    countryCode: system["Country Code"] ?? undefined,
    location: system.Location ?? undefined,
    accessInformation: system["Access Information"] ?? undefined,
    status: "unavailable",
  };
}

/**
 * Read a stored credential. Secrets declared `x-openmapx-secret` in the
 * manifest are vault-backed but arrive decrypted on `ctx.config`, the same way
 * `ev-charging` reads `ocm-api-key`. Saving one in admin reloads the
 * integration, so a new key takes effect without a restart.
 */
function credential(ctx: IntegrationContext, key: string): string | undefined {
  const value = ctx.config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The credential for a named keyed feed, when the operator has stored one. */
function namedAuth(ctx: IntegrationContext, id: string): GofsAuth | undefined {
  const keyed = KEYED_FEEDS.find((f) => f.id === id);
  if (!keyed) return undefined;
  const value = credential(ctx, `${keyed.sourceId}-api-key`);
  if (!value) return undefined;
  return { kind: keyed.auth.kind, name: keyed.auth.name, value };
}

/**
 * The credential for an operator feed bound to a generic slot. The slot's auth
 * scheme lives in the plain `feeds[]` entry — a header name is not a secret —
 * while only the key itself goes to the vault.
 */
function slotAuth(ctx: IntegrationContext, entry: Record<string, unknown>): GofsAuth | undefined {
  const slot = entry.credentialSlot;
  if (typeof slot !== "number" || !CUSTOM_SLOTS.includes(slot)) return undefined;
  const value = credential(ctx, `gofs-custom-${slot}-api-key`);
  if (!value) return undefined;
  const kind = entry.authKind === "query" ? "query" : "header";
  const name =
    typeof entry.authParam === "string" && entry.authParam.trim()
      ? entry.authParam.trim()
      : "X-API-KEY";
  return { kind, name, value };
}

function readOperatorFeeds(ctx: IntegrationContext): CatalogEntry[] {
  const raw = ctx.config.feeds;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const { id, name, url } = record;
    if (typeof id !== "string" || !id || typeof url !== "string" || !isUsableUrl(url)) return [];
    return [
      {
        id,
        name: typeof name === "string" && name ? name : id,
        url,
        auth: slotAuth(ctx, record),
        origin: "operator" as const,
        status: "unavailable" as const,
      },
    ];
  });
}

function statusFromError(err: unknown): CatalogStatus {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);
  // A registry entry that answers with an auth challenge is a real feed we
  // simply cannot read yet — surface it with its access link rather than
  // hiding it, so an operator can go and get a key.
  if (status === 401 || status === 403 || /\b40[13]\b/.test(message)) {
    return "credential-required";
  }
  return "unavailable";
}

export function createGofsCatalog(ctx: IntegrationContext, fetchJson?: GofsFetchJson) {
  // Named `doFetch`, not `fetch`: shadowing the global would both confuse
  // readers and defeat the repo guard that looks for bare fetch() in
  // integrations.
  const doFetch: GofsFetchJson = fetchJson ?? ((url, headers) => safeFetchJson(url, { headers }));

  // The cache is an optimisation, not a dependency. A Redis outage must read as
  // a miss and fall through to a live fetch — treating it as an error would
  // silently empty the whole catalog, which is exactly what happened the first
  // time this ran against a host with Redis down.
  async function cacheGet<T>(key: string): Promise<T | null> {
    try {
      return await ctx.cache.get<T>(key);
    } catch {
      return null;
    }
  }

  async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await ctx.cache.set(key, value, ttlSeconds);
    } catch {
      // Nothing to do: the value was still computed and returned to the caller.
    }
  }

  async function loadUpstream(): Promise<CatalogEntry[]> {
    if (ctx.config.useUpstreamCatalog === false) return [];
    const cached = await cacheGet<UpstreamSystem[]>(CATALOG_CACHE_KEY);
    if (cached) return cached.flatMap((s) => toEntry(s, "upstream") ?? []);
    try {
      const systems =
        ((await doFetch(UPSTREAM_URL)) as { systems?: UpstreamSystem[] })?.systems ?? [];
      await cacheSet(CATALOG_CACHE_KEY, systems, CATALOG_TTL_SECONDS);
      return systems.flatMap((s) => toEntry(s, "upstream") ?? []);
    } catch (err) {
      // A registry outage must not take out the operator's own feeds.
      ctx.log.warn(
        "GOFS upstream catalog unavailable",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  function loadSupplement(): CatalogEntry[] {
    const systems = (supplement as { systems?: UpstreamSystem[] }).systems ?? [];
    return systems.flatMap((s) => toEntry(s, "supplement") ?? []);
  }

  /**
   * Fetch an entry's discovery document to decide whether it is worth
   * offering. Cached, so a dead or key-gated feed is not re-probed per request.
   *
   * The cache key includes whether a credential is present, so storing a key
   * for a feed that previously answered 401 re-probes immediately instead of
   * being shadowed by the cached rejection for the rest of the TTL.
   */
  async function probe(entry: CatalogEntry): Promise<CatalogEntry> {
    const key = `gofs:probe:${entry.id}:${entry.auth ? "keyed" : "anon"}`;
    const cached = await cacheGet<CatalogStatus>(key);
    if (cached) return { ...entry, status: cached };

    let status: CatalogStatus;
    try {
      const { url, headers } = applyGofsAuth(entry.url, entry.auth);
      const doc = await doFetch(url, headers);
      status = parseGofsDiscovery(doc).length > 0 ? "live" : "unavailable";
    } catch (err) {
      status = statusFromError(err);
    }
    await cacheSet(key, status, PROBE_TTL_SECONDS);
    return { ...entry, status };
  }

  /**
   * Merge the three sources, later origins winning on id collision, then probe
   * everything concurrently. Operator entries win because they are the only
   * way to point at a private or keyed deployment.
   */
  async function resolveFeeds(): Promise<CatalogEntry[]> {
    const byId = new Map<string, CatalogEntry>();
    for (const entry of [...(await loadUpstream()), ...loadSupplement()]) {
      // Registry and supplement entries pick up a credential when we ship
      // named support for that feed and the operator has stored a key.
      byId.set(entry.id, { ...entry, auth: namedAuth(ctx, entry.id) });
    }
    for (const entry of readOperatorFeeds(ctx)) byId.set(entry.id, entry);

    const probed = await Promise.all([...byId.values()].map(probe));
    return probed.filter((e) => e.status !== "unavailable");
  }

  return { resolveFeeds };
}
