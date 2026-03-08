export interface FuelPrices {
  e5?: number;
  e10?: number;
  diesel?: number;
}

export interface FuelAttribution {
  label: string;
  url: string;
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
