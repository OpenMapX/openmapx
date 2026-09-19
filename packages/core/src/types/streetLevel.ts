import type { LngLat } from "./geometry";

/** A provider-qualified reference to one street-level image. */
export interface StreetLevelRef {
  providerId: string;
  imageId: string;
}

/** Tiled-panorama asset template, used for high-resolution 360 imagery. */
export interface StreetLevelTiledAsset {
  urlTemplate: string;
  cols: number;
  rows: number;
}

/** One street-level image, normalised across providers. */
export interface StreetLevelImage {
  id: string;
  providerId: string;
  lngLat: LngLat;
  /** Compass heading in degrees, north = 0. */
  heading?: number;
  /** ISO 8601 capture timestamp. */
  capturedAt?: string;
  isPano: boolean;
  /**
   * Horizontal field of view in degrees; 360 for equirectangular. Absent when
   * the provider cannot tell, in which case nothing is projected onto a flat
   * image.
   */
  fovDeg?: number;
  /** Width / height of the frame, when the provider reports the sensor's shape. */
  aspectRatio?: number;
  sequenceId?: string;
  assets: {
    thumb?: string;
    sd?: string;
    hd?: string;
    tiles?: StreetLevelTiledAsset;
  };
  author?: string;
  license?: string;
  licenseUrl?: string;
  pageUrl?: string;
}

/** A navigable neighbour of an image. Becomes a clickable arrow. */
export interface StreetLevelLink {
  id: string;
  /** May differ from the source image's provider — cross-provider hops are allowed. */
  providerId: string;
  lngLat: LngLat;
  rel: "next" | "prev" | "related";
  capturedAt?: string;
}

export type StreetLevelCoverage =
  | {
      kind: "mvt";
      tileUrlTemplate: string;
      minzoom: number;
      maxzoom: number;
      layers: { sequences: string; pictures: string; grid?: string };
      props: {
        id: string;
        isPano?: string;
        panoValue?: string | boolean;
        heading?: string;
        capturedAt?: string;
      };
    }
  | {
      kind: "geojson-tiles";
      tileUrlTemplate: string;
      minzoom: number;
      maxzoom: number;
    };

/** Query for the provider `/search` surface (navigation photo prefetch). */
export interface StreetLevelSearchQuery {
  /** Search centre. */
  lngLat: LngLat;
  radiusM: number;
  /** Keep images whose heading is within ±headingToleranceDeg of this bearing. */
  heading?: number;
  headingToleranceDeg?: number;
  /** ISO 8601 lower bound on capturedAt. */
  capturedAfter?: string;
  /** A point the image should see (Panoramax `place_position`); providers without it fall back to radius. */
  lookingAt?: LngLat;
  limit?: number;
}

export interface StreetLevelCapabilities {
  id: string;
  name: string;
  /** Layer colour used to distinguish this provider's coverage on the map. */
  color: string;
  attributionHtml?: string;
  licenseUrl?: string;
  privacyUrl?: string;
  /** Whether the browser fetches imagery straight from the provider. */
  endUserExposure: "direct" | "server-only";
  coverage: StreetLevelCoverage;
  /**
   * Whether the provider's terms allow showing its imagery during real-time
   * navigation. The junction photo only searches providers that do; the
   * street-level viewer is unaffected.
   */
  allowsNavigationUse: boolean;
  /** What the provider's `/search` route can filter server-side. */
  search: {
    /** Provider filters by heading server-side; otherwise the route filters client-side. */
    heading: boolean;
    capturedAfter: boolean;
    lookingAt: boolean;
  };
}
