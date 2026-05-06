import { type BoundingBox, USER_AGENT } from "@openmapx/core";
import { deduplicateChargingStations } from "./dedup.js";
import { getEvChargingSourcePriority } from "./source-priority.js";
import type { EvChargingConnector, EvChargingSource, EvChargingStation } from "./types.js";
import {
  bboxContainsCoordinates,
  bboxOverlaps,
  cleanString,
  connector,
  parseLocalizedNumber,
} from "./utils.js";

interface FranceIrveRecord {
  id_station_itinerance?: string | null;
  id_station_local?: string | null;
  nom_station?: string | null;
  nom_operateur?: string | null;
  nom_amenageur?: string | null;
  nom_enseigne?: string | null;
  adresse_station?: string | null;
  consolidated_code_postal?: string | null;
  consolidated_commune?: string | null;
  consolidated_longitude?: number | string | null;
  consolidated_latitude?: number | string | null;
  longitude?: number | string | null;
  latitude?: number | string | null;
  point_geo?: { lon?: number; lat?: number } | null;
  nbre_pdc?: number | string | null;
  id_pdc_itinerance?: string | null;
  id_pdc_local?: string | null;
  puissance_nominale?: number | string | null;
  prise_type_ef?: boolean | string | number | null;
  prise_type_2?: boolean | string | number | null;
  prise_type_combo_ccs?: boolean | string | number | null;
  prise_type_chademo?: boolean | string | number | null;
  prise_type_autre?: boolean | string | number | null;
  gratuit?: boolean | string | number | null;
  paiement_acte?: boolean | string | number | null;
  paiement_cb?: boolean | string | number | null;
  paiement_autre?: boolean | string | number | null;
  tarification?: string | null;
  condition_acces?: string | null;
  reservation?: boolean | string | number | null;
  horaires?: string | null;
  accessibilite_pmr?: string | null;
  restriction_gabarit?: string | null;
  station_deux_roues?: boolean | string | number | null;
  observations?: string | null;
  date_mise_en_service?: string | null;
  date_maj?: string | null;
  last_modified?: string | null;
  datagouv_organization_or_owner?: string | null;
  datagouv_dataset_id?: string | null;
  datagouv_resource_id?: string | null;
}

interface FranceIrveResponse {
  total_count?: number;
  results?: FranceIrveRecord[];
}

const RECORDS_URL =
  "https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/mobilityref-france-irve-220/records";
const DATASET_URL =
  "https://www.data.gouv.fr/fr/datasets/fichier-consolide-des-bornes-de-recharge-pour-vehicules-electriques/";
const LICENSE_URL = "https://www.data.gouv.fr/pages/legal/licences/etalab-2.0";
const COVERAGE = { south: 41, west: -5.5, north: 51.5, east: 10 };
const PAGE_SIZE = 100;
const MAX_RECORDS = 2000;

function isTruthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  const lower = value.trim().toLowerCase();
  return ["1", "true", "oui", "yes", "y"].includes(lower);
}

function recordId(record: FranceIrveRecord): string | undefined {
  return (
    cleanString(record.id_pdc_itinerance ?? undefined) ??
    cleanString(record.id_pdc_local ?? undefined) ??
    cleanString(record.id_station_itinerance ?? undefined) ??
    cleanString(record.id_station_local ?? undefined)
  );
}

function recordCoordinates(record: FranceIrveRecord): [number, number] | null {
  const lng =
    parseLocalizedNumber(record.consolidated_longitude) ??
    parseLocalizedNumber(record.longitude) ??
    record.point_geo?.lon;
  const lat =
    parseLocalizedNumber(record.consolidated_latitude) ??
    parseLocalizedNumber(record.latitude) ??
    record.point_geo?.lat;
  if (lng === undefined || lat === undefined) return null;
  return [lng, lat];
}

function paymentMethods(record: FranceIrveRecord): string[] | undefined {
  const methods: string[] = [];
  if (isTruthy(record.paiement_cb)) methods.push("Card");
  if (isTruthy(record.paiement_acte)) methods.push("Ad hoc payment");
  if (isTruthy(record.paiement_autre)) methods.push("Other");
  return methods.length > 0 ? methods : undefined;
}

function recordConnectors(record: FranceIrveRecord): EvChargingConnector[] {
  const powerKw = parseLocalizedNumber(record.puissance_nominale);
  const connectors: EvChargingConnector[] = [];
  const add = (enabled: unknown, type: string) => {
    if (isTruthy(enabled)) connectors.push(connector({ type, powerKw, quantity: 1 }));
  };
  add(record.prise_type_combo_ccs, "CCS");
  add(record.prise_type_chademo, "CHAdeMO");
  add(record.prise_type_2, "Type 2");
  add(record.prise_type_ef, "Schuko");
  add(record.prise_type_autre, "Other");

  if (connectors.length === 0 && powerKw) {
    connectors.push(connector({ type: "Unknown", powerKw, quantity: 1 }));
  }
  return connectors;
}

function recordAttribution(record: FranceIrveRecord): EvChargingStation["attributions"] {
  const owner = cleanString(record.datagouv_organization_or_owner ?? undefined);
  if (!owner) return undefined;
  return [
    {
      text: owner,
      url: DATASET_URL,
      license: "Licence Ouverte / Open Licence 2.0",
      licenseUrl: LICENSE_URL,
    },
  ];
}

function recordToStation(record: FranceIrveRecord): EvChargingStation | null {
  const id = recordId(record);
  const coordinates = recordCoordinates(record);
  if (!id || !coordinates) return null;
  const operatorName = cleanString(record.nom_operateur ?? undefined);

  const sourceItemIds = [
    record.id_pdc_itinerance,
    record.id_pdc_local,
    record.id_station_itinerance,
    record.id_station_local,
  ]
    .map((value) => cleanString(value ?? undefined))
    .filter((value): value is string => Boolean(value))
    .map((value) => `france-irve:${value}`);

  const notes = [
    cleanString(record.observations ?? undefined),
    cleanString(record.restriction_gabarit ?? undefined),
    isTruthy(record.reservation) ? "Reservation supported" : undefined,
    isTruthy(record.station_deux_roues) ? "Two-wheelers supported" : undefined,
  ].filter((value): value is string => Boolean(value));

  return {
    id: `france-irve:${id}`,
    sources: ["france-irve"],
    sourceItemIds,
    name:
      cleanString(record.nom_station ?? undefined) ??
      cleanString(record.nom_enseigne ?? undefined) ??
      "EV Charging Station",
    coordinates,
    attributions: recordAttribution(record),
    address: {
      line1: cleanString(record.adresse_station ?? undefined),
      town: cleanString(record.consolidated_commune ?? undefined),
      postcode: cleanString(record.consolidated_code_postal ?? undefined),
      country: "France",
    },
    operator: operatorName ? { name: operatorName } : undefined,
    status: "unknown",
    usageType: cleanString(record.condition_acces ?? undefined),
    usageCost: isTruthy(record.gratuit)
      ? "Free"
      : (cleanString(record.tarification ?? undefined) ?? undefined),
    openingHours: cleanString(record.horaires ?? undefined),
    access: cleanString(record.accessibilite_pmr ?? undefined),
    paymentMethods: paymentMethods(record),
    connectors: recordConnectors(record),
    updatedAt:
      cleanString(record.last_modified ?? undefined) ??
      cleanString(record.date_maj ?? undefined) ??
      cleanString(record.date_mise_en_service ?? undefined),
    sourceUrl: DATASET_URL,
    notes: notes.length > 0 ? notes : undefined,
  };
}

function whereForBbox(bbox: BoundingBox): string {
  return `in_bbox(point_geo, ${bbox.north}, ${bbox.west}, ${bbox.south}, ${bbox.east})`;
}

async function fetchRecords(params: URLSearchParams): Promise<FranceIrveResponse> {
  const response = await fetch(`${RECORDS_URL}?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new Error(`France IRVE API error: ${response.status}`);
  return (await response.json()) as FranceIrveResponse;
}

export async function searchFranceIrveCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  if (!bboxOverlaps(bbox, COVERAGE)) return [];
  const stations: EvChargingStation[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total && offset < MAX_RECORDS) {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      where: whereForBbox(bbox),
    });
    const page = await fetchRecords(params);
    total = page.total_count ?? 0;
    const records = page.results ?? [];
    stations.push(
      ...records
        .map(recordToStation)
        .filter((station): station is EvChargingStation => Boolean(station))
        .filter((station) => bboxContainsCoordinates(bbox, station.coordinates)),
    );
    if (records.length === 0) break;
    offset += records.length;
  }

  return deduplicateChargingStations(stations);
}

function escapeOdsString(value: string): string {
  return value.replace(/'/g, "''");
}

export async function fetchFranceIrveChargingDetail(
  itemId: string,
): Promise<EvChargingStation | null> {
  const id = itemId.startsWith("france-irve:") ? itemId.slice("france-irve:".length) : itemId;
  const escaped = escapeOdsString(id);
  const params = new URLSearchParams({
    limit: "50",
    where: `id_pdc_itinerance='${escaped}' OR id_pdc_local='${escaped}' OR id_station_itinerance='${escaped}' OR id_station_local='${escaped}'`,
  });
  const page = await fetchRecords(params);
  const stations = (page.results ?? [])
    .map(recordToStation)
    .filter((station): station is EvChargingStation => Boolean(station));
  return deduplicateChargingStations(stations)[0] ?? null;
}

export const franceIrveSource: EvChargingSource = {
  id: "france-irve",
  priority: getEvChargingSourcePriority("france-irve"),
  search: searchFranceIrveCharging,
  canFetchDetail: (itemId) => itemId.startsWith("france-irve:"),
  fetchDetail: fetchFranceIrveChargingDetail,
};
