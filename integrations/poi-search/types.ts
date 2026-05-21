import type { BoundingBox, LngLat, OpeningHoursInfo, Place } from "@openmapx/core";
// Import from the dedicated place-ids subpath (pure types + helpers, no hooks)
// to avoid cycling back into @openmapx/core via the main barrel when this file
// is consumed by server-only callers like packages/core/src/server.ts.
import { createPlace, parseId } from "@openmapx/core/place-ids";

export type CategoryId =
  | "restaurants"
  | "hotels"
  | "activities"
  | "museums"
  | "transit"
  | "pharmacies"
  | "atms"
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
  | "fuel"
  | "schools"
  | "kindergartens"
  | "ambulance_stations"
  | "fire_stations"
  | "police"
  | "parks"
  | "churches"
  | "post_offices"
  | "ev_charging"
  | "swimming"
  | "nightlife"
  | "bakeries"
  | "aeds"
  | "toilets"
  | "laundromats"
  | "hairdressers"
  | "opticians"
  | "recycling"
  | "car_rental"
  | "bicycle_rental"
  | "airports"
  | "beaches"
  | "viewpoints"
  | "camping"
  | "dog_parks"
  | "drinking_water"
  | "veterinarians"
  | "blood_donation"
  | "mosques"
  | "synagogues"
  | "temples"
  | "markets"
  | "shopping_malls"
  | "bookstores"
  | "bike_sharing"
  | "scooter_sharing"
  | "car_sharing"
  | (string & {});

export interface CategoryDefinition {
  id: CategoryId;
  label: string;
  /** Show as a chip in the chip bar. False = available via search only. */
  showInChipBar: boolean;
  /** SVG path `d` attribute (24x24 viewBox) used for the map marker icon. */
  iconPath: string;
  /** Whether this category supports the opening hours filter chip. */
  supportsHoursFilter?: boolean;
}

export const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
  {
    id: "restaurants",
    label: "Restaurants",
    showInChipBar: true,
    supportsHoursFilter: true,
    iconPath:
      "M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4",
  },
  {
    id: "hotels",
    label: "Hotels",
    showInChipBar: true,
    supportsHoursFilter: true,
    iconPath:
      "M7 13c1.66 0 3-1.34 3-3S8.66 7 7 7s-3 1.34-3 3 1.34 3 3 3m12-6h-8v7H3V5H1v15h2v-3h18v3h2v-9c0-2.21-1.79-4-4-4",
  },
  {
    id: "activities",
    label: "Activities",
    showInChipBar: true,
    supportsHoursFilter: true,
    iconPath:
      "M20 12c0-1.1.9-2 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2m-4.42 4.8L12 14.5l-3.58 2.3 1.08-4.12-3.29-2.69 4.24-.25L12 5.8l1.54 3.95 4.24.25-3.29 2.69z",
  },
  {
    id: "museums",
    label: "Museums",
    showInChipBar: true,
    supportsHoursFilter: true,
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
    supportsHoursFilter: true,
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
  {
    id: "cafes",
    label: "Cafes",
    showInChipBar: false,
    supportsHoursFilter: true,
    iconPath:
      "M20 3H4v10c0 2.21 1.79 4 4 4h6c2.21 0 4-1.79 4-4v-3h2c1.11 0 2-.9 2-2V5c0-1.11-.89-2-2-2m0 5h-2V5h2zM4 19h16v2H4z",
  },
  {
    id: "bars",
    label: "Bars & Pubs",
    showInChipBar: false,
    supportsHoursFilter: true,
    iconPath:
      "M19 9h-1.56c.35-.59.56-1.27.56-2 0-2.21-1.79-4-4-4-.34 0-.66.05-.98.13-.82-.68-1.86-1.11-3.02-1.11-1.89 0-3.51 1.11-4.27 2.71C4.15 5.26 3 6.74 3 8.5c0 1.86 1.28 3.41 3 3.86V21h11v-2h2c1.1 0 2-.9 2-2v-6c0-1.1-.9-2-2-2M7 10.5c-1.1 0-2-.9-2-2 0-.85.55-1.6 1.37-1.88l.8-.27.36-.76C8 4.62 8.94 4.02 10 4.02c.79 0 1.39.35 1.74.65l.78.65S13.16 5 13.99 5c1.1 0 2 .9 2 2h-3C9.67 7 9.15 10.5 7 10.5M19 17h-2v-6h2z",
  },
  {
    id: "supermarkets",
    label: "Supermarkets",
    showInChipBar: false,
    supportsHoursFilter: true,
    iconPath:
      "M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2M1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49c.08-.14.12-.31.12-.48 0-.55-.45-1-1-1H5.21l-.94-2zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2",
  },
  {
    id: "hospitals",
    label: "Hospitals",
    showInChipBar: false,
    supportsHoursFilter: true,
    iconPath:
      "M19 3H5c-1.1 0-1.99.9-1.99 2L3 19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2m-1 11h-4v4h-4v-4H6v-4h4V6h4v4h4z",
  },
  {
    id: "doctors",
    label: "Doctors & Clinics",
    showInChipBar: false,
    supportsHoursFilter: true,
    iconPath:
      "M20 6h-4V4c0-1.1-.9-2-2-2h-4c-1.1 0-2 .9-2 2v2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2M10 4h4v2h-4zm6 11h-3v3h-2v-3H8v-2h3v-3h2v3h3z",
  },
  {
    id: "dentists",
    label: "Dentists",
    showInChipBar: false,
    supportsHoursFilter: true,
    iconPath:
      "m17.73 12.02 3.98-3.98c.39-.39.39-1.02 0-1.41l-4.34-4.34a.996.996 0 0 0-1.41 0l-3.98 3.98L8 2.29C7.8 2.1 7.55 2 7.29 2c-.25 0-.51.1-.7.29L2.25 6.63c-.39.39-.39 1.02 0 1.41l3.98 3.98L2.25 16c-.39.39-.39 1.02 0 1.41l4.34 4.34c.39.39 1.02.39 1.41 0l3.98-3.98 3.98 3.98c.2.2.45.29.71.29s.51-.1.71-.29l4.34-4.34c.39-.39.39-1.02 0-1.41zM12 9c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1m-4.71 1.96L3.66 7.34l3.63-3.63 3.62 3.62zM10 13c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1m2 2c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1m2-4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1m2.66 9.34-3.63-3.62 3.63-3.63 3.62 3.62z",
  },
  {
    id: "gyms",
    label: "Gyms",
    showInChipBar: false,
    supportsHoursFilter: true,
    iconPath:
      "M20.57 14.86 22 13.43 20.57 12 17 15.57 8.43 7 12 3.43 10.57 2 9.14 3.43 7.71 2 5.57 4.14 4.14 2.71 2.71 4.14l1.43 1.43L2 7.71l1.43 1.43L2 10.57 3.43 12 7 8.43 15.57 17 12 20.57 13.43 22l1.43-1.43L16.29 22l2.14-2.14 1.43 1.43 1.43-1.43-1.43-1.43L22 16.29z",
  },
  {
    id: "libraries",
    label: "Libraries",
    showInChipBar: false,
    supportsHoursFilter: true,
    iconPath:
      "M12 11.55C9.64 9.35 6.48 8 3 8v11c3.48 0 6.64 1.35 9 3.55 2.36-2.19 5.52-3.55 9-3.55V8c-3.48 0-6.64 1.35-9 3.55M12 8c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3",
  },
  {
    id: "cinemas",
    label: "Cinemas",
    showInChipBar: false,
    supportsHoursFilter: true,
    iconPath:
      "M18 3v2h-2V3H8v2H6V3H4v18h2v-2h2v2h8v-2h2v2h2V3zM8 17H6v-2h2zm0-4H6v-2h2zm0-4H6V7h2zm10 8h-2v-2h2zm0-4h-2v-2h2zm0-4h-2V7h2z",
  },
  {
    id: "banks",
    label: "Banks",
    showInChipBar: false,
    supportsHoursFilter: true,
    iconPath:
      "M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2zm-9-2h10V8H12zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5",
  },
  {
    id: "car_repair",
    label: "Car Repair",
    showInChipBar: false,
    supportsHoursFilter: true,
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
    id: "schools",
    label: "Schools",
    showInChipBar: false,
    iconPath: "M5 13.18v4L12 21l7-3.82v-4L12 17zM12 3 1 9l11 6 9-4.91V17h2V9z",
  },
  {
    id: "kindergartens",
    label: "Kindergartens",
    showInChipBar: false,
    iconPath:
      "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2M8.5 8c.83 0 1.5.67 1.5 1.5S9.33 11 8.5 11 7 10.33 7 9.5 7.67 8 8.5 8m7 0c.83 0 1.5.67 1.5 1.5S16.33 11 15.5 11 14 10.33 14 9.5 14.67 8 15.5 8M12 18c-2.28 0-4.22-1.66-5-4h10c-.78 2.34-2.72 4-5 4",
  },
  {
    id: "ambulance_stations",
    label: "Ambulance Stations",
    showInChipBar: false,
    iconPath:
      "M10.5 13H8v-3h2.5V7.5h3V10H16v3h-2.5v2.5h-3zM12 2 4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5z",
  },
  {
    id: "fire_stations",
    label: "Fire Stations",
    showInChipBar: false,
    iconPath:
      "M12 12.9l-2.13 2.09c-.56.56-.87 1.29-.87 2.07C9 18.68 10.35 20 12 20s3-1.32 3-2.94c0-.78-.31-1.52-.87-2.07zM16 6l-.44.55C14.38 5.03 12.5 4 10.39 4 7.41 4 5 6.41 5 9.39c0 2.39 1.55 4.44 3.68 5.25L12 11l4-5z",
  },
  {
    id: "police",
    label: "Police",
    showInChipBar: false,
    iconPath:
      "M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5zm-1 14H9v-2h2zm0-4H9V7h2zm4 4h-2v-2h2zm0-4h-2V7h2z",
  },
  {
    id: "parks",
    label: "Parks",
    showInChipBar: false,
    iconPath: "M17 12h2L12 2 5.05 12H7l-3.9 6h6.92v4h3.96v-4H21z",
  },
  {
    id: "churches",
    label: "Churches",
    showInChipBar: false,
    iconPath:
      "M18 12.22V9l-5-2.5V5h2V3h-2V1h-2v2H9v2h2v1.5L6 9v3.22L2 14v8h8v-3c0-1.1.9-2 2-2s2 .9 2 2v3h8v-8z",
  },
  {
    id: "post_offices",
    label: "Post Offices",
    showInChipBar: false,
    iconPath:
      "M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2m0 4-8 5-8-5V6l8 5 8-5z",
  },
  {
    id: "swimming",
    label: "Swimming Pools",
    showInChipBar: false,
    iconPath:
      "M22 21c-1.11 0-1.73-.37-2.5-1-1.12.93-3.23 1-4.5 0-1.12.93-3.23 1-4.5 0-1.12.93-3.23 1-4.5 0-.77.63-1.39 1-2.5 1v-2c1.12 0 1.73-.37 2.5-1 1.12.93 3.23 1 4.5 0 1.12.93 3.23 1 4.5 0 1.12.93 3.23 1 4.5 0 .77.63 1.38 1 2.5 1zM18.5 9.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2M8 9l4-7.93L16 9z",
  },
  {
    id: "nightlife",
    label: "Nightlife",
    showInChipBar: false,
    iconPath:
      "M1 5h14l-6 9v4h2v2H5v-2h2v-4zm9.1 4 1.4-2H4.49l1.4 2zM17 5h5v3h-3v9c0 1.66-1.34 3-3 3s-3-1.34-3-3 1.34-3 3-3c.35 0 .69.06 1 .17z",
  },
  {
    id: "bakeries",
    label: "Bakeries",
    showInChipBar: false,
    iconPath:
      "M20.5 17.5c.4 0 .75-.23.92-.58L23 13l-1.93-3.96c-.17-.35-.52-.54-.89-.54H15c-.55 0-1 .45-1 1v2h-2V9.5l6.5-1V5l-6.5 1V3h-2v3.13L4 7.5v3h-.5c-.55 0-1 .45-1 1V19h16v-1.5zm-4-5h4l1 2.5-1 2.5h-4v-5zm-2 5H4v-6h10.5v6z",
  },
  {
    id: "aeds",
    label: "AEDs (Defibrillators)",
    showInChipBar: false,
    iconPath:
      "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z",
  },
  {
    id: "toilets",
    label: "Toilets",
    showInChipBar: false,
    iconPath:
      "M5.5 22v-7.5H4V9c0-1.1.9-2 2-2h3c1.1 0 2 .9 2 2v5.5H9.5V22zM7 6c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2m10.5 16v-7.5H19V9c0-1.1-.9-2-2-2h-3c-1.1 0-2 .9-2 2v5.5h1.5V22zm-2.5-16c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2",
  },
  {
    id: "laundromats",
    label: "Laundromats",
    showInChipBar: false,
    iconPath:
      "M9.17 16.83C9.7 17.37 10.35 17.67 11.02 17.9c-.87-1.02-1.4-2.34-1.4-3.77 0-1.55.6-2.97 1.58-4.03-.28-.1-.57-.17-.86-.19C9.72 10.53 9 11.93 9 13.43c0 1.2.43 2.33 1.13 3.22zm7.58-7.65c-.28-.13-.6-.21-.93-.23-.28.01-.56.08-.81.19.97 1.06 1.58 2.48 1.58 4.03 0 1.43-.53 2.75-1.4 3.77.67-.23 1.32-.53 1.85-1.07.72-.91 1.13-2.04 1.13-3.23-.01-1.33-.52-2.54-1.42-3.46zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-3c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z",
  },
  {
    id: "hairdressers",
    label: "Hairdressers & Barbers",
    showInChipBar: false,
    iconPath:
      "M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2m0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2m6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5M19 3l-6 6 2 2 7-7V3z",
  },
  {
    id: "opticians",
    label: "Opticians",
    showInChipBar: false,
    iconPath:
      "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5M12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5m0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3",
  },
  {
    id: "recycling",
    label: "Recycling Centers",
    showInChipBar: false,
    iconPath:
      "M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8m0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4z",
  },
  {
    id: "car_rental",
    label: "Car Rental",
    showInChipBar: false,
    iconPath:
      "M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16m11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5M5 11l1.5-4.5h11L19 11z",
  },
  {
    id: "bicycle_rental",
    label: "Bicycle Rental",
    showInChipBar: false,
    iconPath:
      "M15.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2M5 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5m0 8.5c-1.93 0-3.5-1.57-3.5-3.5S3.07 13.5 5 13.5s3.5 1.57 3.5 3.5S6.93 20.5 5 20.5m5.8-10l2.4-2.4.8.8c1.3 1.3 3 2.1 5.1 2.1V11c-1.5 0-2.7-.6-3.6-1.5l-1.9-1.9c-.5-.4-1-.6-1.6-.6s-1.1.2-1.4.6L7.8 10.4c-.4.4-.6.9-.6 1.4 0 .6.2 1.1.6 1.4L11 16v5h2v-6.2zm9.2 1.5c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5m0 8.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5",
  },
  {
    id: "airports",
    label: "Airports",
    showInChipBar: false,
    iconPath:
      "M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z",
  },
  {
    id: "beaches",
    label: "Beaches",
    showInChipBar: false,
    iconPath:
      "M13.127 14.56l1.43-1.43 6.44 6.443L19.57 21zm4.293-5.73l2.86-2.86c-3.95-3.95-10.35-3.96-14.3-.02 3.93-1.3 8.31-.25 11.44 2.88zM5.95 5.98c-3.94 3.95-3.93 10.35.02 14.3l2.86-2.86C5.7 14.29 4.65 9.91 5.95 5.98z",
  },
  {
    id: "viewpoints",
    label: "Viewpoints",
    showInChipBar: false,
    iconPath: "M14 6l-1-2H5v17h2v-7h5l1 2h7V6z",
  },
  {
    id: "camping",
    label: "Camping",
    showInChipBar: false,
    iconPath: "M9 22l-3-9h12l-3 9zm3-20 10 6H2z",
  },
  {
    id: "dog_parks",
    label: "Dog Parks",
    showInChipBar: false,
    // MUI Pets icon
    iconPath:
      "M4.5 9.5m-2.5 0a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0M9 5.5m-2.5 0a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0M15 5.5m-2.5 0a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0M19.5 9.5m-2.5 0a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0M17.34 14.86c-.87-1.02-1.6-1.89-2.48-2.91-.46-.54-1.05-1.08-1.75-1.32-.11-.04-.22-.07-.33-.09-.25-.04-.52-.04-.78-.04s-.53 0-.79.05c-.11.02-.22.05-.33.09-.7.24-1.28.78-1.75 1.32-.87 1.02-1.6 1.89-2.48 2.91-1.31 1.31-2.92 2.76-2.62 4.79.29 1.02 1.02 2.03 2.33 2.32.73.15 3.06-.44 5.54-.44h.18c2.48 0 4.81.58 5.54.44 1.31-.29 2.04-1.31 2.33-2.32.31-2.04-1.3-3.49-2.61-4.8",
  },
  {
    id: "drinking_water",
    label: "Drinking Water",
    showInChipBar: false,
    iconPath:
      "M17.66 8L12 2.35 6.34 8C4.78 9.56 4 11.64 4 13.64s.78 4.11 2.34 5.67 3.61 2.35 5.66 2.35 4.1-.79 5.66-2.35S20 15.64 20 13.64 19.22 9.56 17.66 8zM6 14c.01-2 .62-3.27 1.76-4.4L12 5.27l4.24 4.38C17.38 10.77 17.99 12 18 14H6z",
  },
  {
    id: "veterinarians",
    label: "Veterinarians",
    showInChipBar: false,
    // MUI Healing icon
    iconPath:
      "M17.73 12.02l3.98-3.98c.39-.39.39-1.02 0-1.41l-4.34-4.34a.996.996 0 0 0-1.41 0l-3.98 3.98L8 2.29C7.8 2.1 7.55 2 7.29 2c-.25 0-.51.1-.7.29L2.25 6.63c-.39.39-.39 1.02 0 1.41l3.98 3.98L2.25 16c-.39.39-.39 1.02 0 1.41l4.34 4.34c.39.39 1.02.39 1.41 0l3.98-3.98 3.98 3.98c.2.2.45.29.71.29s.51-.1.71-.29l4.34-4.34c.39-.39.39-1.02 0-1.41zM12 9c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1m-4.71 1.96L3.66 7.34l3.63-3.63 3.62 3.62zM10 13c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1m2 2c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1m2-4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1m2.66 9.34l-3.63-3.62 3.63-3.63 3.62 3.62z",
  },
  {
    id: "blood_donation",
    label: "Blood Donation",
    showInChipBar: false,
    iconPath:
      "M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z",
  },
  {
    id: "mosques",
    label: "Mosques",
    showInChipBar: false,
    iconPath: "M6.5 10h-2v7h2zm6 0h-2v7h2zm8.5 9H2v2h19zm-2.5-9h-2v7h2zM11.5 1L2 6v2h19V6z",
  },
  {
    id: "synagogues",
    label: "Synagogues",
    showInChipBar: false,
    iconPath:
      "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm4.24 16L12 15.45 7.77 18l1.12-4.81-3.73-3.23 4.92-.42L12 5l1.92 4.53 4.92.42-3.73 3.23z",
  },
  {
    id: "temples",
    label: "Temples",
    showInChipBar: false,
    iconPath:
      "M12 3L2 12h3v8h6v-5h2v5h6v-8h3L12 3zm0 12.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z",
  },
  {
    id: "markets",
    label: "Markets",
    showInChipBar: false,
    iconPath:
      "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7m0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5",
  },
  {
    id: "shopping_malls",
    label: "Shopping Malls",
    showInChipBar: false,
    iconPath:
      "M19 6H17c0-2.76-2.24-5-5-5S7 3.24 7 6H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2m-7-3c1.66 0 3 1.34 3 3H9c0-1.66 1.34-3 3-3m7 17H5V8h14zm-7-8c-1.66 0-3-1.34-3-3H7c0 2.76 2.24 5 5 5s5-2.24 5-5h-2c0 1.66-1.34 3-3 3",
  },
  {
    id: "bookstores",
    label: "Bookstores",
    showInChipBar: false,
    iconPath:
      "M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z",
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
  isOpen?: boolean;
  /** Server-precomputed status/bitmap; absent when `openingHours` is missing. */
  openingHoursInfo?: OpeningHoursInfo;
}

export interface CategorySearchResponse {
  results: CategoryPlace[];
  partial: boolean;
}

/** Set of category IDs that support the opening hours filter chip, derived from CATEGORY_DEFINITIONS. */
export const HOURS_FILTER_CATEGORY_IDS: ReadonlySet<string> = new Set(
  CATEGORY_DEFINITIONS.filter((c) => c.supportsHoursFilter).map((c) => c.id),
);

/** Converts a CategoryPlace to a Place, using name as address fallback.
 *  When `categoryId` is provided it is stored as `rawCategory` so that
 *  `useDataSourceMatch` can resolve the matching data source. */
export function categoryPlaceToPlace(place: CategoryPlace, categoryId?: string): Place {
  // CategoryPlace.id is always an Overpass-derived canonical id
  // (`osm:node/…`, `osm:way/…`). Parse it so `ids.osm` holds the bare
  // OSM ref value expected by downstream consumers.
  const parsed = parseId(place.id);
  const osmRef = parsed?.scheme === "osm" ? parsed.value : place.id;
  return createPlace({
    primaryScheme: "osm",
    ids: { osm: osmRef },
    name: place.name,
    address: place.address ?? place.name,
    coordinates: place.coordinates,
    category: place.category,
    rawCategory: categoryId,
    phone: place.phone,
    website: place.website,
    openingHours: place.openingHours,
    isOpen: place.isOpen,
    openingHoursInfo: place.openingHoursInfo,
  });
}

export interface PoiSearchResult {
  id: string;
  name: string;
  coordinates: LngLat;
  category?: string;
  address?: string;
  phone?: string;
  website?: string;
  openingHours?: string;
  isOpen?: boolean;
  osmTags?: Record<string, string>;
  /** Set by the orchestrator after the provider returns results. */
  openingHoursInfo?: OpeningHoursInfo;
}

export interface PoiSearchProvider {
  readonly id: string;
  readonly categories: string[];
  search(
    category: string,
    bbox: BoundingBox,
    options?: {
      lang?: string;
      filters?: Record<string, unknown>;
      /** Pre-derived OSM tag-set (AND semantics; `"*"` means key existence). When
       *  present, the provider should query for features matching all of these
       *  tags together instead of looking up `category` in its internal
       *  `CATEGORY_FILTERS` map. Set by the orchestrator on `preset:`-prefixed
       *  category requests. */
      osmTags?: Record<string, string>;
    },
  ): Promise<PoiSearchResult[]>;
  getDetail?(poiId: string): Promise<Place | null>;
}
