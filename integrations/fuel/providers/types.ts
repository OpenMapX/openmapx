export interface FuelPrices {
  diesel?: number;
  e5?: number;
  e10?: number;
  sp98?: number;
  e85?: number;
  lpg?: number;
}

export interface FuelAttribution {
  label: string;
  url: string;
  license?: string;
  licenseUrl?: string;
}

export interface FuelStation {
  id: string;
  name: string;
  brand?: string;
  coordinates: [number, number];
  address?: string;
  isOpen?: boolean;
  fuelPrices: FuelPrices;
  /** ISO 8601 timestamp of the most recent price update, if available. */
  fuelPricesUpdatedAt?: string;
  attribution?: FuelAttribution;
}
