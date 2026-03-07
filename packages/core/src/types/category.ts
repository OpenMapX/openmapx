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
  /** SVG path `d` attribute (24×24 viewBox) used for the map marker icon. */
  iconPath: string;
}

export const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
  // Chip bar
  {
    id: "restaurants",
    label: "Restaurants",
    showInChipBar: true,
    iconPath:
      "M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4",
  },
  {
    id: "hotels",
    label: "Hotels",
    showInChipBar: true,
    iconPath:
      "M7 13c1.66 0 3-1.34 3-3S8.66 7 7 7s-3 1.34-3 3 1.34 3 3 3m12-6h-8v7H3V5H1v15h2v-3h18v3h2v-9c0-2.21-1.79-4-4-4",
  },
  {
    id: "activities",
    label: "Activities",
    showInChipBar: true,
    iconPath:
      "M20 12c0-1.1.9-2 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2m-4.42 4.8L12 14.5l-3.58 2.3 1.08-4.12-3.29-2.69 4.24-.25L12 5.8l1.54 3.95 4.24.25-3.29 2.69z",
  },
  {
    id: "museums",
    label: "Museums",
    showInChipBar: true,
    iconPath: "M4 10h3v7H4zm6.5 0h3v7h-3zM2 19h20v3H2zm15-9h3v7h-3zm-5-9L2 6v2h20V6z",
  },
  {
    id: "transit",
    label: "Transit",
    showInChipBar: true,
    iconPath:
      "M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17m9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5m1.5-6H6V6h12z",
  },
  {
    id: "pharmacies",
    label: "Pharmacies",
    showInChipBar: true,
    iconPath:
      "M21 5h-2.64l1.14-3.14L17.15 1l-1.46 4H3v2l2 6-2 6v2h18v-2l-2-6 2-6zm-5 9h-3v3h-2v-3H8v-2h3V9h2v3h3z",
  },
  {
    id: "atms",
    label: "ATMs",
    showInChipBar: true,
    iconPath:
      "M11 17h2v-1h1c.55 0 1-.45 1-1v-3c0-.55-.45-1-1-1h-3v-1h4V8h-2V7h-2v1h-1c-.55 0-1 .45-1 1v3c0 .55.45 1 1 1h3v1H9v2h2zm9-13H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2m0 14H4V6h16z",
  },
  // Search-only
  {
    id: "cafes",
    label: "Cafes",
    showInChipBar: false,
    iconPath:
      "M20 3H4v10c0 2.21 1.79 4 4 4h6c2.21 0 4-1.79 4-4v-3h2c1.11 0 2-.9 2-2V5c0-1.11-.89-2-2-2m0 5h-2V5h2zM4 19h16v2H4z",
  },
  {
    id: "bars",
    label: "Bars & Pubs",
    showInChipBar: false,
    iconPath:
      "M19 9h-1.56c.35-.59.56-1.27.56-2 0-2.21-1.79-4-4-4-.34 0-.66.05-.98.13-.82-.68-1.86-1.11-3.02-1.11-1.89 0-3.51 1.11-4.27 2.71C4.15 5.26 3 6.74 3 8.5c0 1.86 1.28 3.41 3 3.86V21h11v-2h2c1.1 0 2-.9 2-2v-6c0-1.1-.9-2-2-2M7 10.5c-1.1 0-2-.9-2-2 0-.85.55-1.6 1.37-1.88l.8-.27.36-.76C8 4.62 8.94 4.02 10 4.02c.79 0 1.39.35 1.74.65l.78.65S13.16 5 13.99 5c1.1 0 2 .9 2 2h-3C9.67 7 9.15 10.5 7 10.5M19 17h-2v-6h2z",
  },
  {
    id: "supermarkets",
    label: "Supermarkets",
    showInChipBar: false,
    iconPath:
      "M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2M1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49c.08-.14.12-.31.12-.48 0-.55-.45-1-1-1H5.21l-.94-2zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2",
  },
  {
    id: "hospitals",
    label: "Hospitals",
    showInChipBar: false,
    iconPath:
      "M19 3H5c-1.1 0-1.99.9-1.99 2L3 19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2m-1 11h-4v4h-4v-4H6v-4h4V6h4v4h4z",
  },
  {
    id: "doctors",
    label: "Doctors & Clinics",
    showInChipBar: false,
    iconPath:
      "M20 6h-4V4c0-1.1-.9-2-2-2h-4c-1.1 0-2 .9-2 2v2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2M10 4h4v2h-4zm6 11h-3v3h-2v-3H8v-2h3v-3h2v3h3z",
  },
  {
    id: "dentists",
    label: "Dentists",
    showInChipBar: false,
    iconPath:
      "m17.73 12.02 3.98-3.98c.39-.39.39-1.02 0-1.41l-4.34-4.34a.996.996 0 0 0-1.41 0l-3.98 3.98L8 2.29C7.8 2.1 7.55 2 7.29 2c-.25 0-.51.1-.7.29L2.25 6.63c-.39.39-.39 1.02 0 1.41l3.98 3.98L2.25 16c-.39.39-.39 1.02 0 1.41l4.34 4.34c.39.39 1.02.39 1.41 0l3.98-3.98 3.98 3.98c.2.2.45.29.71.29s.51-.1.71-.29l4.34-4.34c.39-.39.39-1.02 0-1.41zM12 9c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1m-4.71 1.96L3.66 7.34l3.63-3.63 3.62 3.62zM10 13c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1m2 2c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1m2-4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1m2.66 9.34-3.63-3.62 3.63-3.63 3.62 3.62z",
  },
  {
    id: "gyms",
    label: "Gyms",
    showInChipBar: false,
    iconPath:
      "M20.57 14.86 22 13.43 20.57 12 17 15.57 8.43 7 12 3.43 10.57 2 9.14 3.43 7.71 2 5.57 4.14 4.14 2.71 2.71 4.14l1.43 1.43L2 7.71l1.43 1.43L2 10.57 3.43 12 7 8.43 15.57 17 12 20.57 13.43 22l1.43-1.43L16.29 22l2.14-2.14 1.43 1.43 1.43-1.43-1.43-1.43L22 16.29z",
  },
  {
    id: "libraries",
    label: "Libraries",
    showInChipBar: false,
    iconPath:
      "M12 11.55C9.64 9.35 6.48 8 3 8v11c3.48 0 6.64 1.35 9 3.55 2.36-2.19 5.52-3.55 9-3.55V8c-3.48 0-6.64 1.35-9 3.55M12 8c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3",
  },
  {
    id: "cinemas",
    label: "Cinemas",
    showInChipBar: false,
    iconPath:
      "M18 3v2h-2V3H8v2H6V3H4v18h2v-2h2v2h8v-2h2v2h2V3zM8 17H6v-2h2zm0-4H6v-2h2zm0-4H6V7h2zm10 8h-2v-2h2zm0-4h-2v-2h2zm0-4h-2V7h2z",
  },
  {
    id: "banks",
    label: "Banks",
    showInChipBar: false,
    iconPath:
      "M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2zm-9-2h10V8H12zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5",
  },
  {
    id: "car_repair",
    label: "Car Repair",
    showInChipBar: false,
    iconPath:
      "M16.22 12c.68 0 1.22-.54 1.22-1.22 0-.67-.54-1.22-1.22-1.22S15 10.11 15 10.78c0 .68.55 1.22 1.22 1.22m-9.66-1.22c0 .67.54 1.22 1.22 1.22S9 11.46 9 10.78c0-.67-.54-1.22-1.22-1.22s-1.22.55-1.22 1.22M7.61 4 6.28 8h11.43l-1.33-4zm8.67-1s.54.01.92.54c.02.02.03.04.05.07.07.11.14.24.19.4.22.65 1.56 4.68 1.56 4.68v6.5c0 .45-.35.81-.78.81h-.44c-.43 0-.78-.36-.78-.81V14H7v1.19c0 .45-.35.81-.78.81h-.44c-.43 0-.78-.36-.78-.81v-6.5S6.34 4.67 6.55 4c.05-.16.12-.28.19-.4.03-.02.04-.04.06-.06.38-.53.92-.54.92-.54zM4 17.01h16V19h-7v3h-2v-3H4z",
  },
  {
    id: "parking",
    label: "Parking",
    showInChipBar: false,
    iconPath:
      "M13 3H6v18h4v-6h3c3.31 0 6-2.69 6-6s-2.69-6-6-6m.2 8H10V7h3.2c1.1 0 2 .9 2 2s-.9 2-2 2",
  },
  {
    id: "fuel",
    label: "Gas Stations",
    showInChipBar: false,
    iconPath:
      "m19.77 7.23.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h10v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77M12 10H6V5h6zm6 0c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1",
  },
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
