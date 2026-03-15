import type { DataSourceDetail, DataSourceDetailSection, DataSourceResult } from "@openmapx/core";
import type { FuelStation } from "./types.js";

interface OpeningTime {
  text: string;
  start: string;
  end: string;
}

const FUEL_LABELS: Record<string, string> = {
  diesel: "Diesel",
  e5: "E5 (Super 95)",
  e10: "E10",
  sp98: "SP98 (Super 98)",
  e85: "E85 (Ethanol)",
  lpg: "LPG (Autogas)",
};

function extractSource(id: string): string {
  const slashIndex = id.indexOf("/");
  return slashIndex > 0 ? id.slice(0, slashIndex) : "unknown";
}

const SUMMARY_LABELS: [keyof FuelStation["fuelPrices"], string][] = [
  ["diesel", "D"],
  ["e5", "E5"],
  ["e10", "E10"],
  ["sp98", "98"],
  ["e85", "E85"],
  ["lpg", "LPG"],
];

function formatPriceSummary(station: FuelStation): string | undefined {
  const parts: string[] = [];
  for (const [key, label] of SUMMARY_LABELS) {
    const price = station.fuelPrices[key];
    if (price !== undefined) {
      parts.push(`${label} ${price.toFixed(3)} \u20AC`);
    }
  }
  return parts.length > 0 ? parts.join(" \u00B7 ") : undefined;
}

function openVariant(isOpen: boolean | undefined): string {
  if (isOpen === true) return "open";
  if (isOpen === false) return "closed";
  return "unknown";
}

function buildSortValues(station: FuelStation): Record<string, number> | undefined {
  const values: Record<string, number> = {};
  for (const [key, price] of Object.entries(station.fuelPrices)) {
    if (price !== undefined) values[key] = price;
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

export function mapFuelStationToResult(station: FuelStation): DataSourceResult {
  const variant = openVariant(station.isOpen);
  return {
    id: station.id,
    name: station.name,
    coordinates: station.coordinates,
    source: extractSource(station.id),
    variant,
    status: variant,
    summary: formatPriceSummary(station),
    operator: station.brand,
    sortValues: buildSortValues(station),
  };
}

function buildFuelPricesTable(station: FuelStation): DataSourceDetailSection | null {
  const rows: (string | number)[][] = [];

  for (const [key, label] of Object.entries(FUEL_LABELS)) {
    const price = station.fuelPrices[key as keyof typeof station.fuelPrices];
    if (price !== undefined) {
      rows.push([label, `${price.toFixed(3)} \u20AC`]);
    }
  }

  if (rows.length === 0) return null;

  return {
    title: "Fuel Prices",
    type: "table",
    columns: ["Fuel Type", "Price (\u20AC)"],
    rows,
    sectionIcon: "fuel",
  };
}

export function mapFuelStationToDetail(station: FuelStation): DataSourceDetail {
  const sections: DataSourceDetailSection[] = [];

  const priceTable = buildFuelPricesTable(station);
  if (priceTable) sections.push(priceTable);

  const attribution = station.attribution
    ? {
        text: station.attribution.label,
        url: station.attribution.url,
        license: station.attribution.license,
        licenseUrl: station.attribution.licenseUrl,
      }
    : {
        text: "OpenStreetMap",
        url: "https://www.openstreetmap.org",
        license: "ODbL",
        licenseUrl: "https://opendatacommons.org/licenses/odbl/",
      };

  return {
    id: station.id,
    source: extractSource(station.id),
    name: station.name,
    coordinates: station.coordinates,
    address: station.address ? { line1: station.address } : undefined,
    attribution,
    operator: station.brand ? { name: station.brand } : undefined,
    sections,
  };
}

interface TankerkoenigRaw {
  isOpen: boolean;
  wholeDay: boolean;
  openingTimes: OpeningTime[];
  overrides: string[];
  fuelPrices: { e5?: number; e10?: number; diesel?: number };
}

/** Maps German day names from the Tankerkoenig API to OSM abbreviations. */
const DE_DAY_TO_OSM: Record<string, string> = {
  Montag: "Mo",
  Dienstag: "Tu",
  Mittwoch: "We",
  Donnerstag: "Th",
  Freitag: "Fr",
  Samstag: "Sa",
  Sonntag: "Su",
  Feiertag: "PH",
};

/** Converts Tankerkoenig opening times to an OSM-format opening_hours string. */
function tankerkoenigToOsmHours(raw: TankerkoenigRaw): string | undefined {
  if (raw.wholeDay) return "24/7";
  if (raw.openingTimes.length === 0) return undefined;

  // Group times by hours range to merge days with identical schedules
  const byHours = new Map<string, string[]>();
  for (const t of raw.openingTimes) {
    const open = t.start.slice(0, 5);
    const close = t.end.slice(0, 5);
    const hoursKey = `${open}-${close}`;
    const osmDay = DE_DAY_TO_OSM[t.text];
    if (!osmDay || osmDay === "PH") continue;
    const existing = byHours.get(hoursKey) ?? [];
    existing.push(osmDay);
    byHours.set(hoursKey, existing);
  }

  if (byHours.size === 0) return undefined;

  const parts: string[] = [];
  for (const [hours, days] of byHours) {
    parts.push(`${days.join(",")} ${hours}`);
  }
  return parts.join("; ");
}

export function buildTankerkoenigDetail(
  station: FuelStation,
  tankerkoenigRaw: TankerkoenigRaw,
): DataSourceDetail {
  const sections: DataSourceDetailSection[] = [];

  // Fuel prices table
  const priceTable = buildFuelPricesTable({
    ...station,
    fuelPrices: {
      ...station.fuelPrices,
      ...tankerkoenigRaw.fuelPrices,
    },
  });
  if (priceTable) sections.push(priceTable);

  const attribution = station.attribution
    ? {
        text: station.attribution.label,
        url: station.attribution.url,
        license: station.attribution.license,
        licenseUrl: station.attribution.licenseUrl,
      }
    : {
        text: "Tankerk\u00F6nig",
        url: "https://www.tankerkoenig.de",
        license: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      };

  return {
    id: station.id,
    source: "tankerkoenig",
    name: station.name,
    coordinates: station.coordinates,
    address: station.address ? { line1: station.address } : undefined,
    attribution,
    operator: station.brand ? { name: station.brand } : undefined,
    openingHours: tankerkoenigToOsmHours(tankerkoenigRaw),
    sections,
  };
}
