import type { ContributingRecord, FieldContributors } from "../contributors.js";
import type { Attribution } from "./attribution.js";

export type EvseStatus =
  | "available"
  | "charging"
  | "occupied"
  | "reserved"
  | "blocked"
  | "out_of_order"
  | "inoperative"
  | "planned"
  | "removed"
  | "unknown";

export interface ChargingConnector extends ContributingRecord {
  /** `<evseKey>/<connectorId>`; unique within the site. */
  key: string;
  /** The OCPI connector standard, e.g. `IEC_62196_T2`. */
  standard: string;
  format?: "socket" | "cable";
  powerType?: string;
  current?: "ac" | "dc";
  maxPowerKw?: number;
  maxVoltage?: number;
  maxAmperage?: number;
  /** Ids of the site tariffs that apply to this connector. */
  tariffIds: string[];
  status?: EvseStatus;
  /** When the source observed `status`. */
  statusAt?: string;
  /** True when `status` has outlived its validity and must not count as live. */
  stale: boolean;
}

export interface Evse extends ContributingRecord {
  key: string;
  evseId?: string;
  /** Identical charge points the source does not tell apart; they carry no live status. */
  quantity: number;
  lifecycle?: string;
  status?: EvseStatus;
  statusAt?: string;
  stale: boolean;
  capabilities: string[];
  parkingRestrictions: string[];
  connectors: ChargingConnector[];
}

export interface EnergyTariffRestrictions {
  startTime?: string;
  endTime?: string;
  startDate?: string;
  endDate?: string;
  days?: ("MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU")[];
  minKwh?: number;
  maxKwh?: number;
  minCurrentA?: number;
  maxCurrentA?: number;
  minPowerKw?: number;
  maxPowerKw?: number;
  minDurationSec?: number;
  maxDurationSec?: number;
  reservation?: string;
  /**
   * The booking made ahead of arrival the element prices: `booking`, its
   * expiry (`booking_expires`), cancelling it (`booking_cancellation_fees`)
   * or overstaying it (`booking_overtime`).
   */
  booking?: string;
}

/**
 * Where the energy supplied at a site, or under a tariff, comes from: whether
 * it is wholly renewable, the supplier and its product, the share of each
 * source and the impact its generation has.
 */
export interface EnergyMix {
  isGreen?: boolean;
  supplierName?: string;
  /** The supplier's product or tariff plan the energy is bought under. */
  productName?: string;
  /** Each source's share in percent, by OpenConditions code (`solar`, `wind`, `general_fossil`). */
  sources: { source: string; pct: number }[];
  /** Grams per kilowatt-hour left behind, by category (`carbon_dioxide`, `nuclear_waste`). */
  impacts: { category: string; gPerKwh: number }[];
}

/** A period the opening hours do not describe, open or closed, as ISO 8601 instants. */
export interface OpeningHoursException {
  start: string;
  end: string;
  open: boolean;
}

export interface EnergyTariff extends ContributingRecord {
  id: string;
  currency: string;
  type?: string;
  elements: {
    components: {
      type:
        | "energy"
        | "time"
        | "flat"
        | "parking_time"
        | "session"
        | "idle"
        | "reservation"
        | "distance";
      price: number;
      vatPct?: number;
      stepSize?: number;
    }[];
    restrictions?: EnergyTariffRestrictions;
  }[];
  minPrice?: number;
  maxPrice?: number;
  priceIncludesVat?: boolean;
  altText?: string;
  url?: string;
  /** Where the energy sold under the tariff comes from. */
  energyMix?: EnergyMix;
  sourceId: string;
}

export interface ChargingSite extends ContributingRecord {
  fieldContributors?: FieldContributors;
  id: string;
  name: string;
  country?: string;
  coordinates: [number, number];
  timeZone?: string;

  operator?: { name: string; website?: string };
  owner?: string;
  brand?: string;
  website?: string;

  address?: string;
  openingHours?: string;
  openingHoursText?: string;
  /** Periods, current or to come, the opening hours do not describe, earliest first. */
  openingHoursExceptions?: OpeningHoursException[];
  /** Whether a vehicle may charge while the site is closed. */
  chargingWhenClosed?: boolean;
  /** Where vehicles stand while they charge, as an OpenConditions code (`parking_garage`). */
  parkingType?: string;
  /** What is at or near the site, as OpenConditions amenity codes (`restaurant`, `wifi`). */
  amenities?: string[];
  /** Where the energy supplied at the site comes from. */
  energyMix?: EnergyMix;

  audience?: "public" | "customers" | "permit" | "private" | "restricted" | "unknown";
  payment: string[];
  authentication: string[];
  closed: boolean;
  planned: boolean;

  evses: Evse[];
  tariffs: EnergyTariff[];
  tariffText?: string;
  notes?: string;

  sources: string[];
  attributions: Attribution[];
}

/**
 * Statuses that say nothing live about a charge point: `unknown`, and the
 * lifecycle states `planned` and `removed`.
 */
const NOT_LIVE: ReadonlySet<EvseStatus> = new Set(["unknown", "planned", "removed"]);

/** A status worth going by: present, not past its validity, and saying what the point does now. */
function fresh(status: EvseStatus | undefined, stale: boolean): EvseStatus | undefined {
  return status !== undefined && !NOT_LIVE.has(status) && !stale ? status : undefined;
}

/**
 * What a charge point is doing, as far as a fresh reading says: its own
 * status, else its connectors'. A charge point serves one vehicle at a time,
 * so it is available when any of its connectors is. Identical charge points
 * the source does not tell apart (`quantity` above 1) have none.
 */
export function freshEvseStatusSelection(
  evse: Evse,
): { status: EvseStatus; at?: string; connectorIndex?: number } | undefined {
  if (evse.quantity > 1) return undefined;
  const own = fresh(evse.status, evse.stale);
  if (own) return { status: own, ...(evse.statusAt ? { at: evse.statusAt } : {}) };
  const byConnector = evse.connectors.filter((c) => fresh(c.status, c.stale));
  const pick = byConnector.find((c) => c.status === "available") ?? byConnector[0];
  if (!pick?.status) return undefined;
  return {
    status: pick.status,
    ...(pick.statusAt ? { at: pick.statusAt } : {}),
    connectorIndex: evse.connectors.indexOf(pick),
  };
}

/** The public status value, selected by the same winner used for provenance. */
export function freshEvseStatus(evse: Evse): { status: EvseStatus; at?: string } | undefined {
  const selected = freshEvseStatusSelection(evse);
  if (!selected) return undefined;
  return { status: selected.status, ...(selected.at ? { at: selected.at } : {}) };
}

/**
 * How many charge points of a site are free, counted over those with a fresh
 * status only, each weighted by its quantity (always 1 for one with a live
 * status); `updatedAt` is the newest of those statuses. Undefined when no
 * status is fresh, so a stale or register-only site never reads as available.
 * Staleness is the provider's, judged against each reading's validity when it
 * read the site.
 */
export function availabilityOf(
  site: ChargingSite,
): { available: number; total: number; updatedAt?: string } | undefined {
  let available = 0;
  let total = 0;
  let updatedAt: string | undefined;
  for (const evse of site.evses) {
    const status = freshEvseStatus(evse);
    if (!status) continue;
    total += evse.quantity;
    if (status.status === "available") available += evse.quantity;
    if (status.at && (!updatedAt || Date.parse(status.at) > Date.parse(updatedAt))) {
      updatedAt = status.at;
    }
  }
  if (total === 0) return undefined;
  return { available, total, ...(updatedAt ? { updatedAt } : {}) };
}
