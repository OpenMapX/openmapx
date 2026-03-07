import type { LngLat } from "./geometry";

export type CategoryId =
  // Chip bar categories
  | "restaurants"
  | "hotels"
  | "activities"
  | "museums"
  | "transit"
  | "pharmacies"
  | "atms"
  // Search-only categories
  | "cafes"
  | "bars"
  | "supermarkets"
  | "hospitals"
  | "doctors"
  | "dentists"
  | "gyms"
  | "libraries"
  | "cinemas"
  | "banks"
  | "car_repair"
  | "parking"
  | "fuel";

export interface CategoryDefinition {
  id: CategoryId;
  label: string;
  /** Show as a chip in the chip bar. False = available via search only. */
  showInChipBar: boolean;
}

export const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
  // Chip bar
  { id: "restaurants", label: "Restaurants", showInChipBar: true },
  { id: "hotels", label: "Hotels", showInChipBar: true },
  { id: "activities", label: "Activities", showInChipBar: true },
  { id: "museums", label: "Museums", showInChipBar: true },
  { id: "transit", label: "Transit", showInChipBar: true },
  { id: "pharmacies", label: "Pharmacies", showInChipBar: true },
  { id: "atms", label: "ATMs", showInChipBar: true },
  // Search-only
  { id: "cafes", label: "Cafes", showInChipBar: false },
  { id: "bars", label: "Bars & Pubs", showInChipBar: false },
  { id: "supermarkets", label: "Supermarkets", showInChipBar: false },
  { id: "hospitals", label: "Hospitals", showInChipBar: false },
  { id: "doctors", label: "Doctors & Clinics", showInChipBar: false },
  { id: "dentists", label: "Dentists", showInChipBar: false },
  { id: "gyms", label: "Gyms", showInChipBar: false },
  { id: "libraries", label: "Libraries", showInChipBar: false },
  { id: "cinemas", label: "Cinemas", showInChipBar: false },
  { id: "banks", label: "Banks", showInChipBar: false },
  { id: "car_repair", label: "Car Repair", showInChipBar: false },
  { id: "parking", label: "Parking", showInChipBar: false },
  { id: "fuel", label: "Gas Stations", showInChipBar: false },
];

export interface CategoryPlace {
  id: string;
  name: string;
  coordinates: LngLat;
  category?: string;
  address?: string;
  phone?: string;
  website?: string;
  openingHours?: string;
}
