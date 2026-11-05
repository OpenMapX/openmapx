import { normalizeProducerUrl } from "@integrations/transit-mobility-database";
import { transitCatalogFeedSchema } from "@openmapx/core/api-contracts";
import {
  createDataManagerTransport,
  getTransitCatalog as readPinnedTransitCatalog,
  unwrapDataManagerResponse,
} from "@openmapx/core/data-manager-sdk";
import { DIAGNOSTIC_CREDENTIAL_KEY_SOURCE } from "@openmapx/core/scrub-secrets";
import { envString } from "@openmapx/core/server-env";
import type { GtfsCatalogProvider } from "@openmapx/integration-framework";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { getIntegrationsByDomain } from "../../integration-host.js";
import type { TransitCatalogFeed } from "./types.js";

const DATA_MANAGER_URL_DEFAULT = "http://localhost:4000";

async function installedCatalog(): Promise<TransitCatalogFeed[]> {
  const transport = createDataManagerTransport({
    baseUrl: envString("DATA_MANAGER_URL", DATA_MANAGER_URL_DEFAULT),
    authToken: envString("DATA_MANAGER_AUTH_TOKEN", ""),
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
          if (parsed.success && credentialFreeDiscoveryUrl(parsed.data.url))
            feeds.push(parsed.data);
        }
      } catch (error) {
        console.warn(`[transit-catalog] provider "${provider.id}" failed:`, error);
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
      console.warn("[transit-catalog] discovery failed:", error);
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
