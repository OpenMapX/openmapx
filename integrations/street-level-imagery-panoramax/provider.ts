import {
  fetchJson,
  type LngLat,
  type StreetLevelImage,
  type StreetLevelLink,
  type StreetLevelSearchQuery,
} from "@openmapx/core";
import type { StreetLevelCapabilities, StreetLevelProvider } from "@openmapx/integration-framework";

/**
 * A phone's main camera is 24–28 mm equivalent, 65–74° across, so a phone
 * photo with no lens data is drawn at 70°. Any other camera without lens data
 * — a dashcam or action cam can be 100–140° — gets no field of view at all,
 * and the navigation photo then leaves out the route drawn over it.
 */
const PHONE_FOV_DEG = 70;
/** Makers whose frames without lens data are phone photos. Sony also sells action cams. */
const PHONE_MAKERS = new Set([
  "apple",
  "fairphone",
  "google",
  "honor",
  "htc",
  "huawei",
  "lge",
  "motorola",
  "nokia",
  "nothing",
  "oneplus",
  "oppo",
  "realme",
  "samsung",
  "vivo",
  "xiaomi",
]);
/** Diagonal of a 35 mm frame, which `FocalLengthIn35mmFilm` is defined against. */
const FULL_FRAME_DIAGONAL_MM = 43.27;
const NEAREST_BOX_DEG = 0.0005;
const NAVIGABLE_RELS = new Set(["next", "prev", "related"]);
/**
 * Lower bound of the `place_distance` band for `place_position` searches. The
 * provider's own default band (3–15 m) only returns frames on top of the
 * point; an approach view is taken tens of metres before it.
 */
const PLACE_BAND_MIN_METERS = 30;

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
  /** Provider entries live at the Feature top level in the live STAC API. */
  providers?: Array<{ name?: string; roles?: string[] }>;
  properties?: {
    datetime?: string;
    license?: string;
    "view:azimuth"?: number;
    "pers:interior_orientation"?: {
      field_of_view?: number;
      camera_manufacturer?: string;
      /** `[width, height]` in pixels, the shape of the frame. */
      sensor_array_dimensions?: number[];
    };
    /** Selected EXIF tags as strings, keyed like `Exif.Photo.FocalLengthIn35mmFilm`. */
    exif?: Record<string, string | undefined>;
    /** The producing instance's account name, a plain string. */
    "geovisio:producer"?: string;
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

/** The Feature top-level `providers[]` entry with the producer role, else the producer string. */
function authorOf(item: StacItem): string | undefined {
  const producer = item.providers?.find((provider) => (provider.roles ?? []).includes("producer"));
  return producer?.name ?? item.properties?.["geovisio:producer"];
}

/** An EXIF number, written plainly ("25", "2.8") or as a rational ("4695/1000"); 0 means unknown. */
function exifNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [numerator, denominator = "1"] = value.split("/");
  const parsed = Number(numerator) / Number(denominator);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The horizontal field of view: Panoramax's own when it knows the camera,
 * else from the 35 mm-equivalent focal length over the frame's shape, else
 * the phone default for a phone, else unknown.
 */
function fieldOfView(
  properties: NonNullable<StacItem["properties"]>,
  width: number | undefined,
  height: number | undefined,
): number | undefined {
  const orientation = properties["pers:interior_orientation"];
  if (orientation?.field_of_view) return orientation.field_of_view;
  const hasShape = !!width && !!height && width > 0 && height > 0;
  const focal35 = exifNumber(properties.exif?.["Exif.Photo.FocalLengthIn35mmFilm"]);
  if (focal35 && width && height && hasShape) {
    // The equivalent focal length is defined against the 35 mm frame's
    // diagonal; the part of that diagonal along the image's width sets the
    // horizontal angle.
    const equivalentWidth = (FULL_FRAME_DIAGONAL_MM * width) / Math.hypot(width, height);
    return Math.round((2 * Math.atan(equivalentWidth / (2 * focal35)) * 180) / Math.PI);
  }
  const maker = (
    orientation?.camera_manufacturer ??
    properties.exif?.["Exif.Image.Make"] ??
    ""
  ).toLowerCase();
  // A 2:1 frame is a panorama whatever made it, never a 70° phone view.
  const panoramaShape = hasShape && width && height ? width === 2 * height : false;
  return PHONE_MAKERS.has(maker) && !panoramaShape ? PHONE_FOV_DEG : undefined;
}

export function stacItemToImage(item: StacItem, providerId: string): StreetLevelImage {
  const properties = item.properties ?? {};
  const orientation = properties["pers:interior_orientation"];
  const spdx = properties.license ?? "CC-BY-SA-4.0";
  const author = authorOf(item);
  const [sensorWidth, sensorHeight] = orientation?.sensor_array_dimensions ?? [];
  const aspectRatio =
    sensorWidth && sensorHeight && sensorWidth > 0 && sensorHeight > 0
      ? sensorWidth / sensorHeight
      : undefined;
  const fovDeg = fieldOfView(properties, sensorWidth, sensorHeight);

  return {
    id: item.id,
    providerId,
    lngLat: (item.geometry?.coordinates ?? [0, 0]) as LngLat,
    heading: properties["view:azimuth"],
    capturedAt: properties.datetime,
    isPano: fovDeg === 360,
    ...(fovDeg !== undefined ? { fovDeg } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    sequenceId: item.collection,
    assets: {
      thumb: item.assets?.thumb?.href,
      sd: item.assets?.sd?.href,
      hd: item.assets?.hd?.href,
    },
    ...(author ? { author } : {}),
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

      // No `nullOnError`: a timeout or 5xx must surface as an upstream failure,
      // not as "there is no imagery here" — those need different answers.
      const data = await fetchJson<StacFeatureCollection>(`${base}/search?bbox=${bbox}&limit=1`, {
        label: "Panoramax search",
      });
      const feature = data?.features?.[0];
      return feature ? stacItemToImage(feature, id) : null;
    },

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
        // Imagery is fetched through the backend image proxy, so the
        // browser never contacts the provider directly.
        endUserExposure: "server-only",
        allowsNavigationUse: true,
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
        search: { heading: false, capturedAfter: true, lookingAt: true },
      };
    },

    async getImage(imageId: string): Promise<StreetLevelImage | null> {
      const item = await fetchJson<StacItem>(`${base}/pictures/${encodeURIComponent(imageId)}`, {
        label: "Panoramax picture",
      });
      return item ? stacItemToImage(item, id) : null;
    },

    async getLinks(imageId: string): Promise<StreetLevelLink[]> {
      // The single-picture endpoint is the only one that emits `related`
      // links; search and item-list responses omit them.
      const item = await fetchJson<StacItem>(`${base}/pictures/${encodeURIComponent(imageId)}`, {
        label: "Panoramax picture",
      });
      return stacLinksToStreetLevelLinks(item?.links, id);
    },

    async searchImages(query: StreetLevelSearchQuery): Promise<StreetLevelImage[]> {
      let data: StacFeatureCollection | undefined;
      if (query.lookingAt) {
        try {
          data = await fetchJson<StacFeatureCollection>(placePositionUrl(base, query), {
            label: "Panoramax search",
          });
        } catch {
          // Some instances reject the distance band or the fov tolerance;
          // the bbox fallback plus the route's own heading filter covers it.
          data = await fetchJson<StacFeatureCollection>(bboxUrl(base, query), {
            label: "Panoramax search",
          });
        }
      } else {
        data = await fetchJson<StacFeatureCollection>(bboxUrl(base, query), {
          label: "Panoramax search",
        });
      }
      return (data?.features ?? []).map((feature) => stacItemToImage(feature, id));
    },
  };
}

/** `place_position` mode: the point the picture must see, from 30 m out to the radius. */
function placePositionUrl(base: string, query: StreetLevelSearchQuery): string {
  const params = new URLSearchParams();
  params.set("place_position", `${query.lookingAt?.[0]},${query.lookingAt?.[1]}`);
  params.set("place_distance", `${PLACE_BAND_MIN_METERS}-${Math.round(query.radiusM)}`);
  const tolerance = clampFovTolerance(2 * (query.headingToleranceDeg ?? 30));
  params.set("place_fov_tolerance", String(tolerance));
  if (query.capturedAfter) params.set("datetime", `${toRfc3339(query.capturedAfter)}/..`);
  params.set("limit", String(query.limit ?? 20));
  return `${base}/search?${params.toString()}`;
}

/** Fallback mode: a bbox around the search centre. */
function bboxUrl(base: string, query: StreetLevelSearchQuery): string {
  const params = new URLSearchParams();
  const deg = query.radiusM / (111_320 * Math.cos((query.lngLat[1] * Math.PI) / 180));
  const latDeg = query.radiusM / 110_970;
  params.set(
    "bbox",
    [
      query.lngLat[0] - deg,
      query.lngLat[1] - latDeg,
      query.lngLat[0] + deg,
      query.lngLat[1] + latDeg,
    ]
      .map((d) => d.toFixed(7))
      .join(","),
  );
  if (query.capturedAfter) params.set("datetime", `${toRfc3339(query.capturedAfter)}/..`);
  params.set("limit", String(query.limit ?? 20));
  return `${base}/search?${params.toString()}`;
}

/** `place_fov_tolerance` is the full cone width, applied as ± half; 2–180. */
function clampFovTolerance(value: number): number {
  return Math.min(Math.max(Math.round(value), 2), 180);
}

/** `capturedAfter` is a date or ISO stamp; the STAC datetime needs RFC 3339. */
function toRfc3339(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().replace(/\.\d+Z$/, "Z");
}
