import type { DataSourceAttribution } from "./attribution.js";
import type { BoundingBox } from "./geometry.js";

export type EvChargingStatus = "operational" | "not-operational" | "planned" | "unknown";

export type EvTariffDimension = "energy" | "time" | "flat" | "parking";

export interface EvChargingPriceComponent {
  type: EvTariffDimension;
  price: number;
  currency: string;
  vat?: number;
  stepSize?: number;
}

export interface EvChargingTariffRestriction {
  timeOfDayStart?: string;
  timeOfDayEnd?: string;
  minPowerKw?: number;
  maxPowerKw?: number;
  currentType?: "ac" | "dc";
  /** Charging-duration bounds (minutes) a price component applies within — e.g. a blocking fee that only applies past a minimum session length. */
  minDurationMinutes?: number;
  maxDurationMinutes?: number;
}

/**
 * A connector group a tariff was associated with at the source. Mirrors the
 * identifying fields of {@link EvChargingConnector} (no live status, no
 * source-native reference) so it can be matched against the station's own
 * connector list.
 */
export interface EvTariffConnectorGroup {
  type?: string;
  powerKw?: number;
  currentType?: string;
  quantity?: number;
}

export interface EvChargingTariff {
  elements: EvChargingPriceComponent[];
  restrictions?: EvChargingTariffRestriction;
  /**
   * Connector groups this tariff was joined to at the source, for feeds that
   * associate tariffs per EVSE/connector rather than per station. Omitted when
   * the source has no such join, or when the tariff covers every connector the
   * station has — both mean "applies station-wide" to consumers.
   */
  appliesTo?: EvTariffConnectorGroup[];
  scope: "country" | "cpo" | "evse";
  isDirectPayment?: boolean;
  source: string;
  sourceUrl?: string;
  /** Human-readable tariff description/terms text from the source (OCPI `tariff_alt_text`). */
  altText?: string;
  updatedAt: string;
}

export interface EvseAvailability {
  /** Number of EVSEs currently AVAILABLE. */
  available: number;
  /** Total number of EVSEs the live feed reports for this station. */
  total: number;
  /** ISO timestamp the live snapshot was produced. */
  updatedAt: string;
}

export interface EvChargingAddress {
  line1?: string;
  town?: string;
  state?: string;
  postcode?: string;
  country?: string;
}

export interface EvChargingConnector {
  type?: string;
  powerKw?: number;
  currentType?: string;
  quantity?: number;
  status?: string;
  reference?: string;
}

export interface EvChargingOperator {
  name: string;
  url?: string;
  legalName?: string;
}

export interface EvChargingStation {
  id: string;
  name: string;
  coordinates: [number, number];
  sources: string[];
  /** Source-native ids that belong to this merged station. Used for cache/detail matching. */
  sourceItemIds?: string[];
  attributions?: DataSourceAttribution[];

  address?: EvChargingAddress;
  operator?: EvChargingOperator;
  status?: EvChargingStatus;
  /** Live per-station EVSE availability, present only when a live feed covers this station. */
  availability?: EvseAvailability;
  /** True when this station's data was augmented by a live feed. */
  isLive?: boolean;

  usageType?: string;
  usageCost?: string;
  membershipRequired?: boolean;
  openingHours?: string;
  access?: string;
  paymentMethods?: string[];

  connectors: EvChargingConnector[];
  tariffs?: EvChargingTariff[];
  updatedAt?: string;
  sourceUrl?: string;
  notes?: string[];
  osmTags?: Record<string, string>;
}

export interface EvChargingSource {
  readonly id: string;
  readonly priority: number;
  search(bbox: BoundingBox, filters?: Record<string, unknown>): Promise<EvChargingStation[]>;
  canFetchDetail?: (itemId: string) => boolean;
  fetchDetail?: (itemId: string) => Promise<EvChargingStation | null>;
}
