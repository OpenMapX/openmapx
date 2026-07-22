import {
  fetchJson,
  type LngLat,
  type StreetLevelImage,
  type StreetLevelLink,
} from "@openmapx/core";
import type { StreetLevelCapabilities, StreetLevelProvider } from "@openmapx/integration-framework";

const DEFAULT_FOV_DEG = 70;
const NEAREST_BOX_DEG = 0.0005;
const NAVIGABLE_RELS = new Set(["next", "prev", "related"]);

interface StacGeometry {
  type: "Point";
  coordinates: [number, number];
}

interface StacLink {
  rel?: string;
  href?: string;
  id?: string;
  datetime?: string;
  geometry?: StacGeometry;
}

export interface StacItem {
  id: string;
  geometry?: StacGeometry;
  collection?: string;
  properties?: {
    datetime?: string;
    license?: string;
    "view:azimuth"?: number;
    "pers:interior_orientation"?: { field_of_view?: number };
    providers?: Array<{ name?: string }>;
    "geovisio:producer"?: { name?: string };
  };
  assets?: Record<string, { href?: string } | undefined>;
  links?: StacLink[];
}

interface StacFeatureCollection {
  features?: StacItem[];
}

/** SPDX "CC-BY-SA-4.0" reads as "CC BY-SA 4.0" in the UI. */
function displayLicense(spdx: string): string {
  return spdx.replace(/^CC-/, "CC ").replace(/-(\d)/, " $1");
}

export function stacItemToImage(item: StacItem, providerId: string): StreetLevelImage {
  const properties = item.properties ?? {};
  const fovDeg = properties["pers:interior_orientation"]?.field_of_view ?? DEFAULT_FOV_DEG;
  const spdx = properties.license ?? "CC-BY-SA-4.0";

  return {
    id: item.id,
    providerId,
    lngLat: (item.geometry?.coordinates ?? [0, 0]) as LngLat,
    heading: properties["view:azimuth"],
    capturedAt: properties.datetime,
    isPano: fovDeg === 360,
    fovDeg,
    sequenceId: item.collection,
    assets: {
      thumb: item.assets?.thumb?.href,
      sd: item.assets?.sd?.href,
      hd: item.assets?.hd?.href,
    },
    author: properties.providers?.[0]?.name ?? properties["geovisio:producer"]?.name,
    license: displayLicense(spdx),
    licenseUrl: item.links?.find((l) => l.rel === "license")?.href,
    pageUrl: `https://panoramax.xyz/#focus=pic&pic=${item.id}`,
  };
}

export function stacLinksToStreetLevelLinks(
  links: StacLink[] | undefined,
  providerId: string,
): StreetLevelLink[] {
  if (!links) return [];

  const result: StreetLevelLink[] = [];
  for (const link of links) {
    if (!link.rel || !NAVIGABLE_RELS.has(link.rel)) continue;
    if (!link.id || !link.geometry) continue;

    result.push({
      id: link.id,
      providerId,
      lngLat: link.geometry.coordinates as LngLat,
      rel: link.rel as StreetLevelLink["rel"],
      capturedAt: link.datetime,
    });
  }
  return result;
}

export function createPanoramaxProvider(options: {
  instanceUrl: string;
  tileUrlTemplate: string;
}): StreetLevelProvider {
  const base = options.instanceUrl.replace(/\/$/, "");
  const id = "panoramax";

  return {
    id,
    name: "Panoramax",

    capabilities(): StreetLevelCapabilities {
      return {
        id,
        name: "Panoramax",
        color: "#e8642c",
        // Instance-dependent in principle: the OSM-France instance publishes
        // CC-BY-SA 4.0, the IGN one Etalab 2.0. Link the licence the default
        // instance uses; per-image `licenseUrl` overrides this when the item
        // declares its own.
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
        // privacyUrl is filled in from the manifest by the street-level-imagery route.
        endUserExposure: "direct",
        coverage: {
          kind: "mvt",
          tileUrlTemplate: options.tileUrlTemplate,
          minzoom: 0,
          maxzoom: 15,
          layers: { sequences: "sequences", pictures: "pictures", grid: "grid" },
          props: {
            id: "id",
            isPano: "type",
            panoValue: "equirectangular",
            heading: "heading",
            capturedAt: "ts",
          },
        },
      };
    },

    async findNearest(lngLat: LngLat): Promise<StreetLevelImage | null> {
      // Panoramax sorts bbox search results by proximity to the box centre,
      // so the first feature is the nearest. There is no distance sort key.
      const [lng, lat] = lngLat;
      const bbox = [
        lng - NEAREST_BOX_DEG,
        lat - NEAREST_BOX_DEG,
        lng + NEAREST_BOX_DEG,
        lat + NEAREST_BOX_DEG,
      ]
        .map((d) => d.toFixed(7))
        .join(",");

      const data = await fetchJson<StacFeatureCollection>(`${base}/search?bbox=${bbox}&limit=1`, {
        nullOnError: true,
      });
      const feature = data?.features?.[0];
      return feature ? stacItemToImage(feature, id) : null;
    },

    async getImage(imageId: string): Promise<StreetLevelImage | null> {
      const item = await fetchJson<StacItem>(`${base}/pictures/${encodeURIComponent(imageId)}`, {
        nullOnError: true,
      });
      return item ? stacItemToImage(item, id) : null;
    },

    async getLinks(imageId: string): Promise<StreetLevelLink[]> {
      // The single-picture endpoint is the only one that emits `related`
      // links; search and item-list responses omit them.
      const item = await fetchJson<StacItem>(`${base}/pictures/${encodeURIComponent(imageId)}`, {
        nullOnError: true,
      });
      return stacLinksToStreetLevelLinks(item?.links, id);
    },
  };
}
