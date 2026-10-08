import type { useTranslations } from "next-intl";

type DataSourcesTranslator = ReturnType<typeof useTranslations<"dataSources">>;

const EXACT_SUMMARY_KEYS: Record<string, string> = {
  "Availability stale": "summaryAvailabilityStale",
  Closed: "summaryClosed",
  Full: "summaryFull",
  "On-Street": "onStreet",
  Parking: "parking",
  "Parking Garage": "parkingGarage",
  "Surface Lot": "surfaceLot",
  "Underground Garage": "undergroundGarage",
};

const EXACT_LABEL_KEYS: Record<string, string> = {
  Access: "filterAccess",
  Availability: "sectionAvailability",
  "Available now": "filterAvailableNow",
  Beach: "cameraBeach",
  Category: "filterCameraCategory",
  "Charging Speed": "filterChargingSpeed",
  City: "cameraCity",
  Connector: "filterConnector",
  "Disabled Parking": "filterDisabledParking",
  "EV Charging": "rowEvCharging",
  "Fast (≤100 kW)": "filterSpeedFast",
  Features: "rowFeatures",
  Fee: "sectionFee",
  Free: "pricingFree",
  "Hide out of service": "filterHideOutOfService",
  "Include Full": "filterIncludeFull",
  Landscape: "cameraLandscape",
  "On-Street": "onStreet",
  Other: "cameraOther",
  "NACS / Tesla": "connectorNacs",
  Paid: "filterPaid",
  "Park & Ride": "rowParkAndRide",
  "Parking Garage": "parkingGarage",
  Public: "public",
  Restricted: "filterRestricted",
  "Slow (≤22 kW)": "filterSpeedSlow",
  "Spaces Available": "filterSpacesAvailable",
  "Surface Lot": "surfaceLot",
  Traffic: "cameraTraffic",
  Type: "rowType",
  "Type 1": "connectorType1",
  "Type 2": "connectorType2",
  "Type 3": "connectorType3",
  "Ultra-Rapid (>100 kW)": "filterSpeedUltraRapid",
  Underground: "undergroundGarage",
  Unknown: "unknownFee",
  Weather: "cameraWeather",
};

const FREE_CAPACITY_RE = /^(\d+)\/(\d+) free$/;
const FREE_SPACES_RE = /^(\d+) free$/;
const SPACES_RE = /^(\d+) spaces$/;

export function translateDataSourceSummary(
  summary: string | undefined,
  t: DataSourcesTranslator,
): string | undefined {
  if (!summary) return summary;

  const exactKey = EXACT_SUMMARY_KEYS[summary];
  if (exactKey) return t(exactKey);

  const freeCapacity = summary.match(FREE_CAPACITY_RE);
  if (freeCapacity) {
    return t("summaryFreeCapacity", {
      capacity: Number(freeCapacity[2]),
      free: Number(freeCapacity[1]),
    });
  }

  const freeSpaces = summary.match(FREE_SPACES_RE);
  if (freeSpaces) {
    return t("summaryFreeSpaces", { count: Number(freeSpaces[1]) });
  }

  const spaces = summary.match(SPACES_RE);
  if (spaces) {
    return t("summarySpaces", { count: Number(spaces[1]) });
  }

  return summary;
}

export function translateDataSourceLabel(label: string, t: DataSourcesTranslator): string {
  const exactKey = EXACT_LABEL_KEYS[label];
  return exactKey ? t(exactKey) : label;
}
