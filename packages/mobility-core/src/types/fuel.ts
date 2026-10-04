import type { Attribution } from "./attribution.js";

/**
 * One product a station sells: a grade, at a service level where the source
 * prices self-service and served pumps apart, sold per litre, kilogram or
 * cubic metre. Each product carries its own price and the time that price was
 * reported, because grades at one station are rarely updated together.
 */
export interface FuelProduct {
  /**
   * Unique within the station: the grade code, plus `:self`/`:served` where
   * both are priced, or `:hgv` for a lorries-only product.
   */
  key: string;
  /** Grade code from the OpenConditions `fuel_grade` vocabulary (e.g. "e10", "diesel", "lpg"). */
  grade: string;
  service?: "self" | "served";
  /** Set for a product sold to lorries only, such as a separate HGV diesel pump. */
  vehicleScope?: "hgv";
  per: "L" | "kg" | "m3";
  price?: { amount: number; currency: string };
  /** ISO 8601 time the price was reported upstream. */
  priceAt?: string;
  /** `false` is an explicit "not sold here", distinct from "unknown". */
  available: boolean | "unknown";
}

export interface FuelStation {
  id: string;
  name: string;
  /** Plain brand name as the source publishes it. */
  brand?: string;
  /** ISO 3166-1 alpha-2 code of the station's country, when known. */
  country?: string;
  coordinates: [number, number];
  address?: string;
  /** OSM-format opening_hours string. */
  openingHours?: string;
  products: FuelProduct[];
  /** True when the source lists every product: a missing product is then not sold. */
  productsComplete: boolean;
  /** Every source id that contributed to this station, most authoritative first. */
  sources: string[];
  attributions: Attribution[];
}
