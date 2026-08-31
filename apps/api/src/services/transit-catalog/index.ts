import { normalizeProducerUrl } from "@integrations/transit-mobility-database";
import { envString } from "@openmapx/core/server-env";
import type { GtfsCatalogProvider } from "@openmapx/integration-framework";
import { getIntegrationsByDomain } from "../../integration-host.js";
import type { TransitCatalogFeed } from "./types.js";

const DATA_MANAGER_URL_DEFAULT = "http://localhost:4000";

async function installedCatalog(): Promise<TransitCatalogFeed[]> {
  const baseUrl = envString("DATA_MANAGER_URL", DATA_MANAGER_URL_DEFAULT).replace(/\/$/, "");
  const token = envString("DATA_MANAGER_AUTH_TOKEN", "");
  const response = await fetch(`${baseUrl}/transit/catalog`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Pinned Transitous catalog failed: HTTP ${response.status}`);
  const body = (await response.json()) as {
    sources?: Array<{
      id: string;
      region: string;
      name: string;
      originUrl?: string;
      license?: Record<string, unknown>;
    }>;
  };
  return (body.sources ?? []).flatMap((source) => {
    if (!source.originUrl) return [];
    const spdx = source.license?.["spdx-identifier"];
    const licenseUrl = source.license?.url;
    return [
      {
        id: source.id,
        name: source.name,
        source: "transitous" as const,
        countryCode: source.region.split(/[.-]/)[0]?.toLowerCase() ?? source.region,
        url: source.originUrl,
        ...(typeof spdx === "string" ? { license: spdx } : {}),
        ...(typeof licenseUrl === "string" ? { licenseUrl } : {}),
      },
    ];
  });
}

async function discoveryCatalog(): Promise<TransitCatalogFeed[]> {
  const feeds: TransitCatalogFeed[] = [];
  for (const integration of getIntegrationsByDomain("gtfs-catalog")) {
    const providers = (integration.providers.get("gtfs-catalog") ?? []) as GtfsCatalogProvider[];
    for (const provider of providers) {
      try {
        feeds.push(...((await provider.listFeeds()) as TransitCatalogFeed[]));
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
  const discoveredUrls = new Set(
    discovered
      .map((feed) => normalizeProducerUrl(feed.url))
      .filter((url): url is string => Boolean(url)),
  );
  const byId = new Map<string, TransitCatalogFeed>();
  for (const feed of installed) {
    const normalized = normalizeProducerUrl(feed.url);
    if (normalized && discoveredUrls.has(normalized)) continue;
    byId.set(feed.id, feed);
  }
  for (const feed of discovered) byId.set(feed.id, feed);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
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
