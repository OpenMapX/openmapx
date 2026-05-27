import type { PoiBundledParseFn, PoiLiveState, PoiRow } from "@openmapx/poi-source-registry";

/**
 * Stadt Bielefeld WFS parking parser.
 *
 * Two distinct data shapes share one feature collection:
 *
 *   1. Major garages (`pls_id` set, `typ` in {"PH","HZ","TZ"}) carry the
 *      full kit: capacity, max height, disabled / women / EV markers,
 *      per-day opening hours, AND a live parking-guidance feed
 *      (`b_pls_rest` = free spaces, `b_pls_zeit` = upstream timestamp,
 *      `b_pls_status` ∈ {FREI,BESETZT,…}).
 *   2. Surface lots (`typ` = "P", no `pls_id`) are a static cadastre of
 *      every parking location in the city — residential, customer, public,
 *      permit-only. No realtime, no capacity.
 *
 * We emit both. Permit-only lots (`gebuehren` ≈ "Ausweis…") are filtered
 * because they would clutter the public-facing map.
 */

interface BielefeldFeatureProperties {
  /** Stable feature id (e.g. "620-1") — the WFS does NOT lift it to feature.id. */
  gid?: string;
  /** Operator-side PLS id, only on major garages. */
  pls_id?: string;
  /** Single-letter type code: "P" surface lot, "PH"/"HZ" multi-storey, "TZ" underground. */
  typ?: string;
  bez?: string;
  kapazitaet?: number;
  /** Free-text height, e.g. "2,00 m". `einfahrtshoehe` carries the same value as a float. */
  hoehe?: string;
  einfahrtshoehe?: number;
  /** Yes/no flag ("J"/"N"): women's parking spots reserved. */
  frauen?: string;
  /** Yes/no flag: disabled parking spots reserved. */
  behinderte?: string;
  zufahrt?: string;
  /** Yes/no flag: EV charging station inside. */
  e_ladesaeule?: string;
  gebuehren?: string;
  gebuehren_internet?: string;
  oeffi?: string;
  kundenp?: string;
  kategorie?: string;
  oeff_mo_fr?: string;
  oeff_sa?: string;
  oeff_so?: string;
  /** Live: remaining free spaces from the PLS feed. */
  b_pls_rest?: number;
  /** Live: ISO-ish "YYYY-MM-DD-HH.MM.SS.uuuuuu" timestamp (Europe/Berlin local). */
  b_pls_zeit?: string;
  /** Live status string: FREI | BESETZT | GESCHLOSSEN | STÖRUNG. */
  b_pls_status?: string;
}

interface BielefeldFeature {
  type: "Feature";
  geometry?: { type: "Point"; coordinates: [number, number] };
  properties?: BielefeldFeatureProperties;
}

interface BielefeldGeoJsonResponse {
  type?: "FeatureCollection";
  features?: BielefeldFeature[];
}

function mapParkingType(typ: string | undefined): "garage" | "underground" | "surface" {
  if (typ === "PH" || typ === "HZ") return "garage";
  if (typ === "TZ") return "underground";
  return "surface";
}

function mapFee(gebuehren: string | undefined): "free" | "paid" | "unknown" {
  if (!gebuehren) return "unknown";
  const value = gebuehren.toLowerCase();
  if (value.includes("kostenlos") || value.includes("frei")) return "free";
  if (value.includes("gebühr") || value.includes("kosten") || value.includes("entgelt")) {
    return "paid";
  }
  return "unknown";
}

function mapAccess(
  kategorie: string | undefined,
  kundenp: string | undefined,
  gebuehren: string | undefined,
): "public" | "customers" | "private" | "permit" | undefined {
  if (gebuehren?.toLowerCase().includes("ausweis")) return "permit";
  if (kundenp === "J") return "customers";
  if (!kategorie) return undefined;
  const lower = kategorie.toLowerCase();
  if (lower.includes("öffentlich") || lower.includes("offentlich")) return "public";
  if (lower.includes("unternehmen") || lower.includes("privat")) return "private";
  return undefined;
}

function parseHeightMeters(raw: string | number | undefined): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.round(raw * 100);
  }
  if (typeof raw !== "string" || !raw) return undefined;
  const normalised = raw.replace(",", ".").replace(/[^\d.]/g, "");
  const meters = Number.parseFloat(normalised);
  if (!Number.isFinite(meters) || meters <= 0) return undefined;
  return Math.round(meters * 100);
}

/**
 * Normalise a single Bielefeld day-string toward OSM `opening_hours`
 * value syntax (https://wiki.openstreetmap.org/wiki/Key:opening_hours).
 *
 * Returns one of:
 *   - `"00:00-24:00"` for "durchgehend" (caller may collapse to `24/7`)
 *   - `"off"` for "geschlossen"
 *   - clean `HH:MM-HH:MM` when the upstream is a pure time range
 *   - the raw upstream string verbatim when it carries a German qualifier
 *     we can't normalise (e.g. `"8:00 - 22:00 (Einfahrt bis 21:30)"`).
 *
 * Passing through the raw German is preferred over dropping the field: a
 * user looking at a German parking facility benefits from operator-supplied
 * caveats (entry deadlines etc.) even when the UI is rendered in English.
 */
function dayValueToOsm(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower.includes("durchgehend")) return "00:00-24:00";
  if (lower.includes("geschlossen") || lower === "off") return "off";
  // Match plain "H:MM - HH:MM" or "HH:MM-HH:MM" with no parenthetical comments.
  const m = trimmed.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (m) {
    const pad = (s: string): string => (s.length === 4 ? `0${s}` : s);
    return `${pad(m[1])}-${pad(m[2])}`;
  }
  return trimmed;
}

/**
 * Stitches Mo-Fr / Sa / So opening-hour strings into a single line, using
 * OSM `opening_hours` syntax where possible and otherwise falling back to
 * English day labels + the operator's raw German values (Bielefeld's PLS
 * occasionally appends qualifiers like "(Einfahrt bis 21:30)" we can't
 * machine-translate). Pure-OSM lines are localisable by opening_hours.js;
 * mixed lines at least keep the day prefixes locale-neutral while preserving
 * the operator-supplied caveat the user actually needs to see.
 */
function combineOpeningHours(props: BielefeldFeatureProperties): string | undefined {
  const mo = dayValueToOsm(props.oeff_mo_fr);
  const sa = dayValueToOsm(props.oeff_sa);
  const so = dayValueToOsm(props.oeff_so);
  if (!mo && !sa && !so) return undefined;
  // All three the same 24h range → "24/7".
  if (mo === "00:00-24:00" && sa === "00:00-24:00" && so === "00:00-24:00") return "24/7";
  // All three identical and non-empty → "Mo-Su <value>" rather than repeating.
  if (mo && mo === sa && mo === so) {
    return mo === "off" ? "Mo-Su off" : `Mo-Su ${mo}`;
  }
  const parts: string[] = [];
  if (mo) parts.push(mo === "off" ? "Mo-Fr off" : `Mo-Fr ${mo}`);
  if (sa) parts.push(sa === "off" ? "Sa off" : `Sa ${sa}`);
  if (so) parts.push(so === "off" ? "Su off" : `Su ${so}`);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/**
 * b_pls_zeit comes back as `YYYY-MM-DD-HH.MM.SS.uuuuuu` (literal dashes
 * between date components and dots in the time). Convert to a proper ISO
 * string in UTC for staleness comparison — the upstream clock is
 * Europe/Berlin local but we treat as UTC for simplicity (1–2 hr drift is
 * inside the staleness window).
 */
function parsePlsTimestamp(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.(\d{2})\.(\d{2})/);
  if (!match) return undefined;
  const [, y, m, d, hh, mm, ss] = match;
  const date = new Date(
    Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)),
  );
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function mapPlsStatus(status: string | undefined): "open" | "closed" | "unknown" {
  if (!status) return "unknown";
  const value = status.toUpperCase();
  if (value === "FREI" || value === "BESETZT") return "open";
  if (value === "GESCHLOSSEN") return "closed";
  return "unknown";
}

export const parseBielefeldDeBundled: PoiBundledParseFn = (buffer) => {
  let data: BielefeldGeoJsonResponse;
  try {
    data = JSON.parse(buffer.toString("utf-8")) as BielefeldGeoJsonResponse;
  } catch {
    return { static: [], live: new Map<string, PoiLiveState>() };
  }
  if (!Array.isArray(data?.features)) {
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  const staticRows: PoiRow[] = [];
  const live = new Map<string, PoiLiveState>();

  for (const feature of data.features) {
    const props = feature.properties ?? {};
    const poiId = props.gid;
    if (!poiId) continue;
    const coords = feature.geometry?.coordinates;
    if (!coords) continue;
    const [lng, lat] = coords;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;

    const access = mapAccess(props.kategorie, props.kundenp, props.gebuehren);
    // Skip permit-only entries — they're staff/resident parking that pollutes
    // the public parking map (~20% of the dataset). Customer-only lots are
    // kept so people searching for retail/leisure parking can find them.
    if (access === "permit") continue;

    const parkingType = mapParkingType(props.typ);
    const capacity =
      typeof props.kapazitaet === "number" && props.kapazitaet > 0 ? props.kapazitaet : undefined;
    const maxHeight = parseHeightMeters(props.einfahrtshoehe ?? props.hoehe);
    // The yes/no flags don't carry exact counts; surface as 1-or-undefined so
    // downstream rendering can show "Yes" via the truthiness check.
    const disabledSpaces = props.behinderte === "J" ? 1 : undefined;
    const womenSpaces = props.frauen === "J" ? 1 : undefined;
    const chargingSpaces = props.e_ladesaeule === "J" ? 1 : undefined;

    staticRows.push({
      poiId,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: props.bez || "Parkplatz",
        parkingType,
        capacity,
        fee: mapFee(props.gebuehren),
        access,
        address: props.zufahrt ?? undefined,
        feeDescription: props.gebuehren || undefined,
        maxHeight,
        disabledSpaces,
        womenSpaces,
        chargingSpaces,
        openingHours: combineOpeningHours(props),
        url: props.gebuehren_internet ?? undefined,
        // Major garages have a stable PLS id worth surfacing in the
        // Source section; surface lots do not.
        sourceUid: props.pls_id || undefined,
        // Flag whether this entry CAN report live data — `hasPlsFeed=true`
        // lets the mapper set hasRealtimeData=true even when the live merge
        // returns null this cycle (b_pls_rest may be temporarily blank).
        // Derived from the structural `pls_id` marker (set only on PLS-fed
        // major garages per the file-header comment), not the per-snapshot
        // `b_pls_rest` value — otherwise a single null tick would flip the
        // flag off and the mapper would label the garage as non-realtime.
        hasPlsFeed: typeof props.pls_id === "string" && props.pls_id.length > 0,
      },
    });

    if (typeof props.b_pls_rest === "number") {
      live.set(poiId, {
        asOf: parsePlsTimestamp(props.b_pls_zeit) ?? new Date().toISOString(),
        freeSpaces: props.b_pls_rest,
        state: mapPlsStatus(props.b_pls_status),
      });
    }
  }

  return { static: staticRows, live };
};
