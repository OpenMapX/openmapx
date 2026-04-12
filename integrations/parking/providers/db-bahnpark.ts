import type { BoundingBox } from "@openmapx/core";
import type { DbBahnParkFacility, ParkingFacility, ParkingType } from "./types.js";

/**
 * DB BahnPark Parking Information API client.
 *
 * ~312 station parking facilities across Germany.
 * Free tier: 1K/month, 10 req/min — we fetch all facilities once and cache 24h.
 * Uses same DB-Client-Id / DB-Api-Key header pattern as RIS APIs,
 * but requires a separate Marketplace subscription (RIS hackathon creds don't cover it).
 */

const API_BASE =
  "https://apis.deutschebahn.com/db-api-marketplace/apis/parking-information/db-bahnpark/v2";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

let facilityCache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;

function getCredentials(): { clientId: string; apiKey: string } | null {
  const clientId = process.env.DB_PARKING_CLIENT_ID;
  const apiKey = process.env.DB_PARKING_API_KEY;
  if (!clientId || !apiKey) return null;
  return { clientId, apiKey };
}

export function isBahnParkConfigured(): boolean {
  return getCredentials() !== null;
}

const TYPE_MAP: Record<string, ParkingType> = {
  Parkhaus: "garage",
  Tiefgarage: "underground",
  Parkplatz: "surface",
  "P+R-Anlage": "surface",
};

function mapType(typeName?: string): ParkingType {
  if (!typeName) return "unknown";
  return TYPE_MAP[typeName] ?? "unknown";
}

function extractName(facility: DbBahnParkFacility): string {
  const display = facility.name.find((n) => n.context === "DISPLAY");
  const name = facility.name.find((n) => n.context === "NAME");
  return display?.name ?? name?.name ?? `Parking ${facility.id}`;
}

function extractCapacity(facility: DbBahnParkFacility): { total?: number; disabled?: number } {
  let total: number | undefined;
  let disabled: number | undefined;

  for (const cap of facility.capacity ?? []) {
    const val = Number.parseInt(cap.total, 10);
    if (Number.isNaN(val)) continue;
    if (cap.type === "PARKING") total = val;
    if (cap.type === "HANDICAPPED_PARKING" && val > 0) disabled = val;
  }

  return { total, disabled };
}

const DURATION_LABELS: Record<string, string> = {
  "20min": "20 min",
  "30min": "30 min",
  "1hour": "1h",
  "1day": "1 day",
  "1dayPCard": "1 day (P-Card)",
  "1week": "1 week",
  "1weekPCard": "1 week (P-Card)",
  "1monthVendingMachine": "1 month",
  "1monthLongTerm": "1 month (long-term)",
  "1monthReservation": "1 month (reserved)",
};

function buildTariffRows(facility: DbBahnParkFacility): [string, string][] | undefined {
  const prices = facility.tariff?.prices;
  if (!prices || prices.length === 0) return undefined;

  const rows: [string, string][] = [];
  for (const p of prices) {
    if (p.price == null || !p.duration) continue;
    if (p.group?.groupName !== "standard") continue;
    const label = DURATION_LABELS[p.duration] ?? p.duration;
    rows.push([label, `€${p.price.toFixed(2)}`]);
  }
  return rows.length > 0 ? rows : undefined;
}

function dbFacilityToParking(f: DbBahnParkFacility): ParkingFacility | null {
  const loc = f.address?.location;
  if (!loc) return null;

  const { total, disabled } = extractCapacity(f);
  const isOutOfService = f.access?.outOfService?.isOutOfService === true;
  const addressParts = [f.address?.streetAndNumber, f.address?.zip, f.address?.city].filter(
    Boolean,
  );

  const heightCm = f.access?.restrictions?.clearance?.height;
  const maxHeight = heightCm ? Number.parseInt(heightCm, 10) : undefined;

  return {
    id: `db-bahnpark:${f.id}`,
    name: extractName(f),
    coordinates: [loc.longitude, loc.latitude],
    sources: ["db-bahnpark"],
    parkingType: mapType(f.type?.name),
    capacity: total,
    hasRealtimeData: false, // list endpoint doesn't include live occupancy
    disabledSpaces: disabled,
    chargingSpaces: f.equipment?.charging?.hasChargingStation ? 1 : undefined,
    maxHeight: maxHeight && !Number.isNaN(maxHeight) ? maxHeight : undefined,
    fee: f.tariff?.prices?.some((p) => p.price != null) ? "paid" : "unknown",
    tariffRows: buildTariffRows(f),
    operator: f.operator?.name ?? "DB BahnPark",
    address: addressParts.length > 0 ? addressParts.join(", ") : undefined,
    openingHours: f.access?.openingHours?.is24h
      ? "24/7"
      : (f.access?.openingHours?.text ?? undefined),
    parkAndRide: f.type?.name === "P+R-Anlage" || undefined,
    nearestStation: f.station?.name ?? undefined,
    chargingDetails: f.equipment?.charging?.details ?? undefined,
    paymentMethods: f.tariff?.information?.dynamic?.tariffPaymentOptions ?? undefined,
    url: f.url ?? undefined,
    state: isOutOfService ? "closed" : "open",
  };
}

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (facilityCache && Date.now() - facilityCache.fetchedAt < CACHE_TTL) {
    return facilityCache.facilities;
  }

  const creds = getCredentials();
  if (!creds) return [];

  const res = await fetch(`${API_BASE}/parking-facilities`, {
    headers: {
      "DB-Client-Id": creds.clientId,
      "DB-Api-Key": creds.apiKey,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`DB BahnPark API failed: ${res.status}`);

  const data = (await res.json()) as { _embedded?: DbBahnParkFacility[] } | DbBahnParkFacility[];
  const raw = Array.isArray(data) ? data : (data._embedded ?? []);

  const facilities: ParkingFacility[] = [];
  for (const f of raw) {
    const parking = dbFacilityToParking(f);
    if (parking) facilities.push(parking);
  }

  facilityCache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchDbBahnPark(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!isBahnParkConfigured()) return [];

  const allFacilities = await fetchAllFacilities();

  return allFacilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function fetchDbBahnParkDetail(facilityId: string): Promise<ParkingFacility | null> {
  if (!isBahnParkConfigured()) return null;

  const creds = getCredentials();
  if (!creds) return null;

  const res = await fetch(`${API_BASE}/parking-facilities/${facilityId}`, {
    headers: {
      "DB-Client-Id": creds.clientId,
      "DB-Api-Key": creds.apiKey,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as DbBahnParkFacility;
  return dbFacilityToParking(data);
}
