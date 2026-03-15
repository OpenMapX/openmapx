/**
 * Maps shared mobility stations and vehicles to DataSource types.
 */

import type { DataSourceDetail, DataSourceDetailSection, DataSourceResult } from "@openmapx/core";
import type { SharedMobilityStation, SharedMobilityVehicle } from "./types.js";

function stationVariant(station: SharedMobilityStation): string {
  if (!station.isActive) return "inactive";
  if (station.availableVehicles === 0) return "empty";
  if (station.emptySlots === 0) return "full";
  return "available";
}

function stationSummary(station: SharedMobilityStation): string {
  const parts: string[] = [];
  parts.push(`${station.availableVehicles} available`);
  if (station.emptySlots !== undefined) {
    parts.push(`${station.emptySlots} slots`);
  }
  return parts.join(" \u00B7 ");
}

export function mapStationToResult(station: SharedMobilityStation): DataSourceResult {
  const variant = stationVariant(station);
  return {
    id: station.id,
    name: station.name,
    coordinates: station.coordinates,
    source: station.source,
    variant,
    status: variant,
    summary: stationSummary(station),
    operator: station.operator,
    sortValues: {
      available: station.availableVehicles,
      slots: station.emptySlots ?? 0,
    },
  };
}

export function mapStationToDetail(station: SharedMobilityStation): DataSourceDetail {
  const sections: DataSourceDetailSection[] = [];

  // Availability table
  const rows: (string | number)[][] = [["Available Vehicles", station.availableVehicles]];
  if (station.emptySlots !== undefined) {
    rows.push(["Empty Slots", station.emptySlots]);
  }
  if (station.capacity !== undefined) {
    rows.push(["Total Capacity", station.capacity]);
  }

  sections.push({
    title: "Availability",
    type: "table",
    columns: ["", ""],
    rows,
    sectionIcon: "info",
  });

  const attribution = station.attribution
    ? {
        text: station.attribution.label,
        url: station.attribution.url,
        license: station.attribution.license,
        licenseUrl: station.attribution.licenseUrl,
      }
    : { text: "GBFS", url: "https://gbfs.org" };

  return {
    id: station.id,
    source: station.source,
    name: station.name,
    coordinates: station.coordinates,
    attribution,
    operator: station.operator ? { name: station.operator } : undefined,
    sections,
  };
}

function vehicleVariant(vehicle: SharedMobilityVehicle): string {
  if (vehicle.isDisabled) return "disabled";
  if (vehicle.isReserved) return "reserved";
  if (vehicle.batteryLevel !== undefined) {
    if (vehicle.batteryLevel < 20) return "low_battery";
    if (vehicle.batteryLevel >= 80) return "high_battery";
    return "medium_battery";
  }
  return "available";
}

function vehicleSummary(vehicle: SharedMobilityVehicle): string {
  const parts: string[] = [];
  if (vehicle.batteryLevel !== undefined) {
    parts.push(`${vehicle.batteryLevel}%`);
  }
  if (vehicle.rangeMeters !== undefined) {
    const km = (vehicle.rangeMeters / 1000).toFixed(1);
    parts.push(`${km} km`);
  }
  return parts.join(" \u00B7 ");
}

export function mapVehicleToResult(vehicle: SharedMobilityVehicle): DataSourceResult {
  const variant = vehicleVariant(vehicle);
  const formLabel = FORM_FACTOR_LABELS[vehicle.formFactor] ?? "Vehicle";
  return {
    id: vehicle.id,
    name: vehicle.operator ? `${vehicle.operator} ${formLabel}` : formLabel,
    coordinates: vehicle.coordinates,
    source: vehicle.source,
    variant,
    status: variant,
    summary: vehicleSummary(vehicle),
    operator: vehicle.operator,
    sortValues: {
      ...(vehicle.batteryLevel !== undefined ? { battery: vehicle.batteryLevel } : {}),
      ...(vehicle.rangeMeters !== undefined ? { range: vehicle.rangeMeters } : {}),
    },
  };
}

export function mapVehicleToDetail(vehicle: SharedMobilityVehicle): DataSourceDetail {
  const sections: DataSourceDetailSection[] = [];

  const rows: (string | number)[][] = [];
  rows.push(["Type", FORM_FACTOR_LABELS[vehicle.formFactor] ?? "Vehicle"]);
  if (vehicle.propulsion) {
    rows.push(["Propulsion", PROPULSION_LABELS[vehicle.propulsion] ?? vehicle.propulsion]);
  }
  if (vehicle.batteryLevel !== undefined) {
    rows.push(["Battery", `${vehicle.batteryLevel}%`]);
  }
  if (vehicle.rangeMeters !== undefined) {
    rows.push(["Range", `${(vehicle.rangeMeters / 1000).toFixed(1)} km`]);
  }
  rows.push([
    "Status",
    vehicle.isReserved ? "Reserved" : vehicle.isDisabled ? "Disabled" : "Available",
  ]);

  sections.push({
    title: "Vehicle Info",
    type: "table",
    columns: ["", ""],
    rows,
    sectionIcon: "info",
  });

  const attribution = vehicle.attribution
    ? {
        text: vehicle.attribution.label,
        url: vehicle.attribution.url,
        license: vehicle.attribution.license,
        licenseUrl: vehicle.attribution.licenseUrl,
      }
    : { text: "GBFS", url: "https://gbfs.org" };

  return {
    id: vehicle.id,
    source: vehicle.source,
    name: vehicle.operator
      ? `${vehicle.operator} ${FORM_FACTOR_LABELS[vehicle.formFactor] ?? "Vehicle"}`
      : (FORM_FACTOR_LABELS[vehicle.formFactor] ?? "Vehicle"),
    coordinates: vehicle.coordinates,
    attribution,
    operator: vehicle.operator ? { name: vehicle.operator } : undefined,
    sections,
  };
}

const FORM_FACTOR_LABELS: Record<string, string> = {
  bicycle: "Bicycle",
  cargo_bicycle: "Cargo Bicycle",
  scooter_standing: "E-Scooter",
  scooter_seated: "Seated Scooter",
  car: "Car",
  moped: "Moped",
  other: "Vehicle",
};

const PROPULSION_LABELS: Record<string, string> = {
  human: "Human-powered",
  electric_assist: "Electric Assist",
  electric: "Electric",
  combustion: "Combustion",
  combustion_diesel: "Diesel",
  hybrid: "Hybrid",
  plug_in_hybrid: "Plug-in Hybrid",
  hydrogen_fuel_cell: "Hydrogen",
};
