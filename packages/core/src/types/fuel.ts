export interface FuelPrices {
  e5?: number;
  e10?: number;
  diesel?: number;
}

export interface FuelOpeningTime {
  text: string;
  start: string;
  end: string;
}

export interface FuelStationDetail {
  id: string;
  isOpen: boolean;
  wholeDay: boolean;
  openingTimes: FuelOpeningTime[];
  overrides: string[];
  fuelPrices: FuelPrices;
}
