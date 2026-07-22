import {
  fetchJson,
  type LngLat,
  type StreetLevelImage,
  type StreetLevelLink,
} from "@openmapx/core";
import type { StreetLevelCapabilities, StreetLevelProvider } from "@openmapx/integration-framework";

const GRAPH = "https://graph.mapillary.com";
const FIELDS =
  "id,computed_geometry,compass_angle,camera_type,captured_at,sequence,thumb_2048_url,thumb_original_url";
// Mapillary's /images endpoint rejects anything wider than ~0.0002 deg per side.
const NEAREST_DELTAS = [0.0001, 0.00015, 0.0002];
const PANO_CAMERA_TYPES = new Set(["spherical", "equirectangular"]);

interface GraphImage {
  id: string;
  computed_geometry?: { type: "Point"; coordinates: [number, number] };
  geometry?: { type: "Point"; coordinates: [number, number] };
  compass_angle?: number;
  camera_type?: string;
  captured_at?: number;
  sequence?: string;
  thumb_2048_url?: string;
  thumb_original_url?: string;
}

interface GraphImagesResponse {
  data?: GraphImage[];
}

function coordinatesOf(raw: GraphImage): LngLat {
  return ((raw.computed_geometry ?? raw.geometry)?.coordinates ?? [0, 0]) as LngLat;
}

export function graphImageToStreetLevelImage(
  raw: GraphImage,
  providerId: string,
): StreetLevelImage {
  const isPano = PANO_CAMERA_TYPES.has(raw.camera_type ?? "");

  return {
    id: raw.id,
    providerId,
    lngLat: coordinatesOf(raw),
    heading: raw.compass_angle,
    capturedAt: raw.captured_at ? new Date(raw.captured_at).toISOString() : undefined,
    isPano,
    fovDeg: isPano ? 360 : undefined,
    sequenceId: raw.sequence,
    assets: {
      sd: raw.thumb_2048_url,
      hd: raw.thumb_original_url,
    },
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    pageUrl: `https://www.mapillary.com/app/?pKey=${raw.id}`,
  };
}

export function createMapillaryProvider(options: {
  accessToken: string;
  tileUrlTemplate: string;
}): StreetLevelProvider {
  const id = "mapillary";
  const token = options.accessToken;

  async function fetchImage(imageId: string): Promise<GraphImage | null> {
    // No `nullOnError`: an upstream timeout or rate-limit must not be reported
    // to the user as "this image does not exist".
    return fetchJson<GraphImage>(
      `${GRAPH}/${encodeURIComponent(imageId)}?fields=${FIELDS}&access_token=${token}`,
      { label: "Mapillary image" },
    );
  }

  function toLink(raw: GraphImage, rel: StreetLevelLink["rel"]): StreetLevelLink {
    return {
      id: raw.id,
      providerId: id,
      lngLat: coordinatesOf(raw),
      rel,
      capturedAt: raw.captured_at ? new Date(raw.captured_at).toISOString() : undefined,
    };
  }

  return {
    id,
    name: "Mapillary",

    capabilities(): StreetLevelCapabilities {
      return {
        id,
        name: "Mapillary",
        color: "#05cb63",
        licenseUrl: "https://www.mapillary.com/terms",
        // privacyUrl is filled in from the manifest by the street-level-imagery route.
        // Imagery is fetched through the backend image proxy, so the
        // browser never contacts the provider directly.
        endUserExposure: "server-only",
        coverage: {
          kind: "mvt",
          tileUrlTemplate: options.tileUrlTemplate,
          minzoom: 6,
          maxzoom: 14,
          layers: { sequences: "sequence", pictures: "image" },
          props: {
            id: "id",
            isPano: "is_pano",
            panoValue: true,
            heading: "compass_angle",
            capturedAt: "captured_at",
          },
        },
      };
    },

    async findNearest(lngLat: LngLat): Promise<StreetLevelImage | null> {
      const [lng, lat] = lngLat;

      for (const delta of NEAREST_DELTAS) {
        const bbox = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`;
        const data = await fetchJson<GraphImagesResponse>(
          `${GRAPH}/images?bbox=${bbox}&fields=${FIELDS}&access_token=${token}&limit=20`,
          { label: "Mapillary search" },
        );
        const images = data?.data ?? [];
        const first = images[0];
        if (!first) continue;

        let nearest = first;
        let minDistance = Number.POSITIVE_INFINITY;
        for (const image of images) {
          const [imgLng, imgLat] = coordinatesOf(image);
          const distance = Math.hypot(imgLng - lng, imgLat - lat);
          if (distance < minDistance) {
            minDistance = distance;
            nearest = image;
          }
        }
        return graphImageToStreetLevelImage(nearest, id);
      }
      return null;
    },

    async getImage(imageId: string): Promise<StreetLevelImage | null> {
      const raw = await fetchImage(imageId);
      return raw ? graphImageToStreetLevelImage(raw, id) : null;
    },

    async getLinks(imageId: string): Promise<StreetLevelLink[]> {
      // Mapillary exposes no cross-sequence neighbour concept, so navigation
      // is limited to stepping along the image's own sequence.
      const current = await fetchImage(imageId);
      if (!current?.sequence) return [];

      // The filter is `sequence_ids` (plural). A singular `sequence_id` on
      // /images returns HTTP 500. The response also carries no guaranteed
      // order, so sort by capture time before treating position as sequence
      // order — index arithmetic on an unordered response misnavigates.
      const data = await fetchJson<GraphImagesResponse>(
        `${GRAPH}/images?sequence_ids=${encodeURIComponent(current.sequence)}&fields=${FIELDS}&access_token=${token}&limit=500`,
        { label: "Mapillary sequence" },
      );
      const images = [...(data?.data ?? [])].sort(
        (a, b) => (a.captured_at ?? 0) - (b.captured_at ?? 0),
      );
      const index = images.findIndex((image) => image.id === imageId);
      if (index === -1) return [];

      const links: StreetLevelLink[] = [];
      const previous = images[index - 1];
      const next = images[index + 1];
      if (previous) links.push(toLink(previous, "prev"));
      if (next) links.push(toLink(next, "next"));
      return links;
    },
  };
}
