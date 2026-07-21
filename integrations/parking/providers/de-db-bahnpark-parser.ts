import { token } from "@openmapx/integration-framework/strings";
import type {
  DbBahnParkFacility,
  I18nTokenLike,
  ParkingType,
} from "@openmapx/mobility-core/parking";
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

const DB_BAHNPARK_DURATION_TOKEN: Record<string, I18nTokenLike> = {
  "20min": token("tariff.dur20min"),
  "30min": token("tariff.dur30min"),
  "1hour": token("tariff.dur1h"),
  "1day": token("tariff.dur1day"),
  "1dayPCard": token("tariff.dur1dayPCard"),
  "1week": token("tariff.dur1week"),
  "1weekPCard": token("tariff.dur1weekPCard"),
  "1monthVendingMachine": token("tariff.dur1month"),
  "1monthLongTerm": token("tariff.dur1monthLong"),
  "1monthReservation": token("tariff.dur1monthReserved"),
};

function buildTariffRows(facility: DbBahnParkFacility): [I18nTokenLike, string][] | undefined {
  const prices = facility.tariff?.prices;
  if (!prices || prices.length === 0) return undefined;

  const rows: [I18nTokenLike, string][] = [];
  for (const p of prices) {
    if (p.price == null || !p.duration) continue;
    if (p.group?.groupName !== "standard") continue;
    // Known DB-BahnPark duration codes map to typed tokens; unknown codes
    // fall back to a literal-template token so the raw upstream label is
    // rendered verbatim without an English leak across the contract.
    const label =
      DB_BAHNPARK_DURATION_TOKEN[p.duration] ?? token("tariff.literal", { value: p.duration });
    rows.push([label, `€${p.price.toFixed(2)}`]);
  }
  return rows.length > 0 ? rows : undefined;
}

export function parseDeDbBahnParkStatic(buffer: Buffer): PoiRow[] {
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
