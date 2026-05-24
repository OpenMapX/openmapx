import type { DbBahnParkFacility, ParkingType } from "@openmapx/mobility-core/parking";
import type { PoiRow } from "@openmapx/poi-source-registry";

/**
 * DB BahnPark Parking Information API parser.
 *
 * Static-only. The list endpoint (`/parking-facilities`) returns either a bare
 * array or a HAL envelope (`_embedded`) of DbBahnParkFacility records — ~312
 * station parking facilities across Germany. Live occupancy is not part of
 * the list endpoint; `hasRealtimeData` stays false post-migration too.
 *
 * Pre-migration id was `db-bahnpark:${facility.id}`.
 */

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

export function parseDbBahnParkStatic(buffer: Buffer): PoiRow[] {
  const text = buffer.toString("utf-8");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }

  let raw: DbBahnParkFacility[];
  if (Array.isArray(data)) {
    raw = data as DbBahnParkFacility[];
  } else if (data && typeof data === "object" && "_embedded" in data) {
    const embedded = (data as { _embedded?: unknown })._embedded;
    raw = Array.isArray(embedded) ? (embedded as DbBahnParkFacility[]) : [];
  } else {
    raw = [];
  }

  const out: PoiRow[] = [];
  for (const f of raw) {
    if (!f?.id) continue;
    const loc = f.address?.location;
    if (!loc) continue;
    const lat = loc.latitude;
    const lng = loc.longitude;
    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const { total, disabled } = extractCapacity(f);
    const isOutOfService = f.access?.outOfService?.isOutOfService === true;
    const addressParts = [f.address?.streetAndNumber, f.address?.zip, f.address?.city].filter(
      Boolean,
    );
    const heightCm = f.access?.restrictions?.clearance?.height;
    const maxHeight = heightCm ? Number.parseInt(heightCm, 10) : undefined;

    out.push({
      poiId: f.id,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: extractName(f),
        parkingType: mapType(f.type?.name),
        capacity: total,
        disabledSpaces: disabled,
        chargingSpaces: f.equipment?.charging?.hasChargingStation ? 1 : undefined,
        maxHeight: maxHeight != null && !Number.isNaN(maxHeight) ? maxHeight : undefined,
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
      },
    });
  }
  return out;
}
