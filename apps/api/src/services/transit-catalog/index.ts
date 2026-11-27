import { normalizeProducerUrl } from "@integrations/transit-mobility-database";
import { transitCatalogFeedSchema } from "@openmapx/core/api-contracts";
import {
  createDataManagerTransport,
  getTransitCatalog as readPinnedTransitCatalog,
  unwrapDataManagerResponse,
} from "@openmapx/core/data-manager-sdk";
import { DIAGNOSTIC_CREDENTIAL_KEY_SOURCE } from "@openmapx/core/scrub-secrets";
import { envString } from "@openmapx/core/server-env";
import { readDataManagerToken } from "@openmapx/core/service-secret-files";
import type { GtfsCatalogProvider } from "@openmapx/integration-framework";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { getIntegrationsByDomain } from "../../integration-host.js";
import { processLogger } from "../../process-logger";
import type { TransitCatalogFeed } from "./types.js";

const DATA_MANAGER_URL_DEFAULT = "http://localhost:4000";

async function installedCatalog(): Promise<TransitCatalogFeed[]> {
  const transport = createDataManagerTransport({
    baseUrl: envString("DATA_MANAGER_URL", DATA_MANAGER_URL_DEFAULT),
    authToken: readDataManagerToken(),
  });
  const body = unwrapDataManagerResponse(await readPinnedTransitCatalog({ transport }));
  return body.sources.flatMap((source) => {
    if (!source.originUrl) return [];
    const spdx = source.license?.["spdx-identifier"];
    const licenseUrl = source.license?.url;
    const licensing = licensingFromDeclaration(
      typeof spdx === "string" ? spdx : undefined,
      typeof licenseUrl === "string" ? licenseUrl : undefined,
    );
    const notice = source.license?.["attribution-text"];
    if (typeof notice === "string" && licensing.bindings[0]) licensing.bindings[0].notice = notice;
    return [
      {
        id: source.id,
        name: source.name,
        source: "transitous" as const,
        countryCode: source.region.split(/[.-]/)[0]?.toLowerCase() ?? source.region,
        url: source.originUrl,
        licensing,
      },
    ];
  });
}

const discoveryFeedSchema = transitCatalogFeedSchema
  .omit({ installedSourceId: true, discoveryIds: true })
  .strip();
const credentialQuery = new RegExp(`^(?:${DIAGNOSTIC_CREDENTIAL_KEY_SOURCE}|authorization)$`, "i");
function credentialFreeDiscoveryUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      ![...url.searchParams.keys()].some((key) => credentialQuery.test(key))
    );
  } catch {
    return false;
  }
}
/**
 * Feeds are listed on every catalogue read, long after registration, so a
 * feed the contract does not accept (a `source` outside 1 to 64 characters,
 * say) cannot be refused when the provider registers. It is left out and its
 * reason logged once per provider and reason, so an extension author can see
 * why without a warning on every read. Bounded, as reasons come from
 * installed code.
 */
const warnedRejections = new Set<string>();
const MAX_WARNED_REJECTIONS = 256;
function warnRejectedFeedOnce(
  providerId: string,
  candidate: unknown,
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): void {
  const reason = issues
    .map((issue) => `${issue.path.map(String).join(".") || "feed"}: ${issue.message}`)
    .join("; ");
  const key = `${providerId}\u0000${reason}`;
  if (warnedRejections.has(key) || warnedRejections.size >= MAX_WARNED_REJECTIONS) return;
  warnedRejections.add(key);
  const feedId =
    candidate && typeof candidate === "object" && "id" in candidate ? candidate.id : undefined;
  processLogger.warn(
    {
      component: "transit-catalog",
      providerId,
      feedId: typeof feedId === "string" ? feedId.slice(0, 200) : undefined,
      reason: reason.slice(0, 1000),
    },
    "A transit catalog provider returned a feed that is not accepted",
  );
}

async function discoveryCatalog(): Promise<TransitCatalogFeed[]> {
  const feeds: TransitCatalogFeed[] = [];
  for (const integration of getIntegrationsByDomain("gtfs-catalog")) {
    const providers = (integration.providers.get("gtfs-catalog") ?? []) as GtfsCatalogProvider[];
    for (const provider of providers) {
      try {
        const candidates = await provider.listFeeds();
        if (!Array.isArray(candidates)) continue;
        for (const candidate of candidates) {
          const parsed = discoveryFeedSchema.safeParse(candidate);
          if (!parsed.success) {
            warnRejectedFeedOnce(provider.id, candidate, parsed.error.issues);
            continue;
          }
          if (credentialFreeDiscoveryUrl(parsed.data.url)) feeds.push(parsed.data);
        }
      } catch (error) {
        processLogger.warn(
          { component: "transit-catalog", err: error, providerId: provider.id },
          "A transit catalog provider failed",
        );
      }
    }
  }
  return feeds.filter(
    (feed) =>
      feed.source !== "mobilitydb" || feed.dataType === undefined || feed.dataType === "gtfs",
  );
}

export async function getTransitCatalog(): Promise<TransitCatalogFeed[]> {
  const [installed, discovered] = await Promise.all([
    installedCatalog(),
    discoveryCatalog().catch((error) => {
      processLogger.warn(
        { component: "transit-catalog", err: error },
        "Transit feed discovery failed",
      );
      return [];
    }),
  ]);
  const byId = new Map<string, TransitCatalogFeed>();
  const byUrl = new Map<string, TransitCatalogFeed[]>();
  for (const feed of installed) {
    const row = { ...feed, installedSourceId: feed.id, discoveryIds: [] as string[] };
    byId.set(feed.id, row);
    const normalized = normalizeProducerUrl(feed.url);
    if (normalized) byUrl.set(normalized, [...(byUrl.get(normalized) ?? []), row]);
  }
  for (const feed of [...discovered].sort((a, b) => a.id.localeCompare(b.id))) {
    const normalized = normalizeProducerUrl(feed.url),
      matches = normalized ? byUrl.get(normalized) : undefined;
    if (matches?.length) {
      for (const row of matches) {
        row.discoveryIds = [...new Set([...(row.discoveryIds ?? []), feed.id])].sort();
        // Discovery can enrich acquisition metadata, never installed provenance.
        row.mdbId ??= feed.mdbId;
        row.bbox ??= feed.bbox;
        row.isOfficial ??= feed.isOfficial;
        row.latestDatasetUrl ??= feed.latestDatasetUrl;
        row.latestDatasetHash ??= feed.latestDatasetHash;
        row.latestDatasetDownloadedAt ??= feed.latestDatasetDownloadedAt;
      }
      continue;
    }
    if (byId.has(feed.id)) continue;
    const row = { ...feed, installedSourceId: null, discoveryIds: [feed.id] };
    byId.set(feed.id, row);
    if (normalized) byUrl.set(normalized, [row]);
  }
  return [...byId.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

export async function searchTransitCatalog(
  query?: string,
  country?: string,
): Promise<TransitCatalogFeed[]> {
  let feeds = await getTransitCatalog();
  if (country) {
    const normalized = country.toLowerCase();
    feeds = feeds.filter((feed) => feed.countryCode.toLowerCase() === normalized);
  }
  if (query?.trim()) {
    const normalized = query.trim().toLowerCase();
    feeds = feeds.filter((feed) =>
      [feed.id, feed.name, feed.countryCode, feed.url].some((value) =>
        value.toLowerCase().includes(normalized),
      ),
    );
  }
  return feeds;
}
