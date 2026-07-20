import type { OsmFilter } from "../utils/overpass.service";
import type { LngLat } from "./geometry";
import type { I18nToken, Translatable } from "./i18nToken";

export interface DataSourceAttribution {
  text: string;
  url: string;
  license?: string;
  licenseUrl?: string;
}

export interface DataSourceBranding {
  name?: string;
  legalName?: string;
  logoUrl?: string;
  logoUrlDark?: string;
  color?: string;
  imageUrl?: string;
  imageUrlDark?: string;
}

export interface DataSourceMapContextSelection {
  systemIds?: string[];
  vehicleTypeIds?: string[];
  providerIds?: string[];
  providerGroupIds?: string[];
  formFactors?: string[];
}

export type DataSourceGeoJsonGeometry =
  | {
      type: "Polygon";
      coordinates: number[][][];
    }
  | {
      type: "MultiPolygon";
      coordinates: number[][][][];
    };

export interface DataSourceGeoJsonFeature {
  type: "Feature";
  geometry: DataSourceGeoJsonGeometry;
  properties: Record<string, unknown> | null;
}

export interface DataSourceGeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: DataSourceGeoJsonFeature[];
}

export interface DataSourceMapContext {
  geojson: DataSourceGeoJsonFeatureCollection;
}

export interface DataSourceMarkerStyle {
  variantColors: Record<string, string>;
  defaultColor: string;
  inactiveOpacity: number;
  iconPath: string;
  /** Marker rendering type. "circle" (default) renders colored dots. "icon" renders SVG icon markers with text labels. */
  type?: "circle" | "icon";
}

export interface DataSourceMeta {
  minZoom: number;
  markerStyle: DataSourceMarkerStyle;
  /** When true, the filter panel shows individual result cards below the filters. */
  showResultsList?: boolean;
  /** Human-readable category name for the Place panel (e.g., "Gas Station"). */
  placeCategory: string;
  /** Raw category string for data source matching (e.g., "fuel"). */
  placeCategoryRaw: string;
  /** Overpass OSM tag filters used to find the corresponding OSM node near a clicked item.
   *  When set, the place panel enriches with data from the matching OSM element instead
   *  of a plain reverse geocode. Omit for sources with no reliable OSM equivalent (webcams, scooters). */
  osmFilters?: OsmFilter[];
}

export interface DataSourceFilterDef {
  id: string;
  label: string;
  type: "multi-select" | "toggle";
  options?: { id: string | number; label: string; icon?: string }[];
  /** When true, this filter is applied client-side on the result set rather than
   *  being sent to the API. Providers set this for filters that cannot be
   *  efficiently evaluated server-side (e.g. speed derived from mapped variants). */
  clientSide?: boolean;
}

export interface DataSourceResult {
  id: string;
  name: string;
  coordinates: LngLat;
  source: string;
  /** All contributing source ids when a result merges records from multiple providers. */
  sources?: string[];
  /** Per-result attribution used by map/source attribution controls when a provider varies by item. */
  attributions?: DataSourceAttribution[];
  /**
   * Distinguishes fixed installations from free-floating items so the place
   * resolver can decide whether to snap to an OSM POI (via `osmFilters`) or
   * fall through to a plain reverse-geocode. Producers that already use the
   * shared-mobility mappers carry the same distinction in the result `id`
   * via an `s:`/`v:` prefix; non-mobility data sources (fuel, EV charging,
   * webcams) leave this unset.
   */
  kind?: "station" | "vehicle";
  variant: string;
  status?: string;
  /** Live EVSE availability rollup, present only for live-covered results. */
  availability?: { available: number; total: number };
  summary?: I18nToken;
  operator?: string;
  branding?: DataSourceBranding;
  mapContext?: DataSourceMapContextSelection;
  /** Structured numeric values for client-side sorting (e.g., fuel prices by type). */
  sortValues?: Record<string, number>;
}

export interface PricingPlanEntry {
  /** Human-readable plan name, or empty string to render a generic fallback label. */
  name: string;
  description?: string;
  currency: string;
  unlockFee?: number;
  perKm?: number;
  perHour?: number;
  free?: boolean;
}

export interface DataSourceDetailSection {
  title: I18nToken;
  /** Optional subtitle rendered beneath the section header (e.g. live availability). */
  caption?: Translatable;
  /**
   * ISO timestamp the `caption` was last refreshed. When present alongside a
   * resolved `caption`, the client appends a locale-aware "updated N ago"
   * suffix (e.g. live availability freshness).
   */
  captionTimestamp?: string;
  type: "table" | "list" | "text" | "image" | "embed" | "pricing";
  columns?: I18nToken[];
  /**
   * Table rows. Two shapes are accepted, distinguished by cell count:
   *
   *  - `[label, value]` 2-tuples for the canonical key/value layout. The
   *    label (left cell) is `I18nToken`-strict — a raw string here is a
   *    compile error, which is what keeps un-translated labels off the wire.
   *    The value (right cell) is `Translatable` (token, raw string, or number),
   *    because the right column legitimately mixes translated text with
   *    upstream pass-through: operator addresses, prices, formatted numbers.
   *    A value may also be a `Translatable[]` — a list of tokens/strings the
   *    client resolves individually and joins (e.g. a localized list of vehicle
   *    accessories in a single cell).
   *  - Wider rows of **3 or more** cells for true multi-column tables driven
   *    by `columns` headers (e.g. EV connector tables). Each cell is a value;
   *    the "label" semantics live in the column header rather than the row, so
   *    cells are unconstrained `Translatable`.
   *
   * The ≥3-cell lower bound on the grid form is load-bearing: it prevents a
   * 2-cell row from satisfying the grid member and thereby smuggling a
   * raw-string label past the token-strict key/value member. The web renderer
   * dispatches on `row.length === 2` to pick between label/value and
   * multi-column rendering.
   */
  rows?:
    | [I18nToken, Translatable | Translatable[]][]
    | [Translatable, Translatable, Translatable, ...Translatable[]][];
  /**
   * User-visible list items. Tokens preferred for fixed vocabulary; raw
   * `string` passthrough allowed for upstream-provided notes (operator
   * descriptions, OSM addenda, quality warnings forwarded verbatim).
   */
  items?: (I18nToken | string)[];
  /**
   * Text-section content. Token for fixed messages, raw `string` passthrough
   * for upstream-provided narrative (operator descriptions, raw notes).
   */
  content?: I18nToken | string;
  /** Image URL for type "image". Rendered as a safe <img> element. */
  imageUrl?: string;
  /** Alt text for image sections. */
  imageAlt?: I18nToken;
  /** Link URL. For "image" sections, wraps the image in an anchor tag. */
  linkUrl?: string;
  /** Embed URL for type "embed". Rendered as a sandboxed iframe or video element. */
  embedUrl?: string;
  /** Embed content type. Defaults to "iframe". "video" renders a video element. */
  embedType?: "iframe" | "video";
  /** Icon type for the section header. */
  sectionIcon?:
    | "bolt"
    | "fuel"
    | "access_time"
    | "info"
    | "directions_bus"
    | "directions_car"
    | "payments"
    | "eco"
    | "open_in_new"
    | "videocam"
    | "warning";
  /** Structured pricing plans for type "pricing". */
  pricingPlans?: PricingPlanEntry[];
  /**
   * Optional clickable links rendered beneath the section caption/body (e.g.
   * a tariff terms link). `url` is omitted when an entry carries descriptive
   * text but no link target — it then renders as plain text instead of a link.
   */
  links?: { label: Translatable; url?: string }[];
  /** When true, the section renders collapsed by default. Embed sections default collapsed in the web UI. */
  collapsed?: boolean;
}

/**
 * Identity hints used by the place resolver to constrain the OSM snap so we
 * don't pull in unrelated business metadata from a "compound" OSM node — e.g.
 * an optician kiosk that's also tagged `amenity=bicycle_rental`. When the
 * provider supplies one of these, `lookupByOsmFilters` will only accept
 * candidates whose tags match at least one identity field (ref, operator,
 * network, or brand — case-insensitive). When omitted, falls back to the old
 * nearest-match behaviour.
 */
export interface OsmIdentity {
  ref?: string;
  operator?: string;
  network?: string;
  brand?: string;
}

export interface DataSourceDetail {
  id: string;
  sources: string[];
  /**
   * Id of the data-source provider that produced this detail (e.g. "parking",
   * "ev-charging"). Stamped by the host's data-source route so the client can
   * resolve this detail's `I18nToken`s against the correct integration string
   * catalog. `sources` is unreliable for this — it lists upstream feeds (often
   * a generic "osm") that several integrations share, so picking the catalog
   * by source coverage ties and selects the wrong integration.
   */
  providerId?: string;
  name: string;
  coordinates: LngLat;
  /** Identity used by the place resolver to gate OSM snapping. See {@link OsmIdentity}. */
  identity?: OsmIdentity;
  address?: {
    line1?: string;
    town?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
  operator?: { name: string; url?: string; legalName?: string };
  /** Per-record attribution that cannot be expressed statically in the integration manifest. */
  attributions?: DataSourceAttribution[];
  branding?: DataSourceBranding;
  usageInfo?: { type: Translatable; cost?: Translatable; membershipRequired?: boolean };
  /** OSM-format opening hours string (e.g., "Mo-Fr 06:00-20:00; Sa-Su 08:00-20:00"). */
  openingHours?: string;
  actions?: {
    primaryRental?: {
      label: I18nToken;
      web?: string;
      ios?: string;
      android?: string;
    };
    mapContext?: {
      label: I18nToken;
      contextId: string;
    };
  };
  sections: DataSourceDetailSection[];
  osmTags?: Record<string, string>;
  /**
   * When true, the detail view should render a "Nearby Transit" section that
   * fetches public transit lines within walking distance of the coordinates.
   * Set by data sources that produce Park+Ride facilities.
   */
  parkAndRide?: boolean;
}
