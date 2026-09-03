export interface FuelPrices {
  diesel?: number;
  e5?: number;
  e10?: number;
  sp98?: number;
  e85?: number;
  lpg?: number;
}

export interface FuelStation {
  id: string;
  name: string;
  brand?: string;
  coordinates: [number, number];
  address?: string;
  isOpen?: boolean;
  /** ISO 4217 currency shared by all prices on this station record. */
  currency: string;
  fuelPrices: FuelPrices;
  /** ISO 8601 timestamp of the most recent price update, if available. */
  fuelPricesUpdatedAt?: string;
  /**
   * Present only when OSM contributed to this station. Priced national feeds
   * (Tankerkoenig, ...) never populate this — they carry a plain-string brand
   * name and no wikidata identity — so it's the brand-catalog gap-fill input,
   * mirroring EvChargingStation/ParkingFacility.
   */
  osmTags?: Record<string, string>;
}
