import { parseXmlDocument, xmlText } from "@openmapx/mobility-formats";
import type { PoiBundledParseFn, PoiLiveState, PoiRow } from "@openmapx/poi-source-registry";

/**
 * Stadtwerke Trier (SWT) parking XML bundled parser.
 *
 * Feed: `service.swt.de/parken-v2.xml` (ISO-8859-1, no coordinates).
 * Each `<parkhaus>` carries only operator-internal short names
 * (Basi, Vieh, Hauptm, Kons, City, Osta, ParkPlaza) + live counts.
 *
 * Because the upstream omits geometry, we enrich each entry with a
 * static coordinate + canonical-name table sourced from OSM. Unknown
 * `phname` values are dropped (rather than placed at city centre) to
 * avoid map clutter if SWT adds a new garage we haven't mapped yet.
 *
 * `<phstate>`: 1 = open/operational, 2 = full, others = closed/unknown.
 */

interface TrierFacility {
  /** Display name shown on the map. */
  name: string;
  /** [lng, lat] WGS84. */
  coordinates: [number, number];
  /** Underground = Tiefgarage, garage = Parkhaus, surface = open lot. */
  parkingType: "garage" | "underground" | "surface";
}

const TRIER_FACILITIES: Record<string, TrierFacility> = {
  Basi: { name: "Parkhaus Basilika", coordinates: [6.6443, 49.7532], parkingType: "garage" },
  Vieh: {
    name: "Tiefgarage Viehmarkt",
    coordinates: [6.637, 49.7527],
    parkingType: "underground",
  },
  Hauptm: { name: "Parkhaus Hauptmarkt", coordinates: [6.6391, 49.7582], parkingType: "garage" },
  Kons: { name: "Parkhaus Konstantin", coordinates: [6.641, 49.7545], parkingType: "garage" },
  City: { name: "City Parkhaus", coordinates: [6.6366, 49.7566], parkingType: "garage" },
  Osta: { name: "Parkhaus Ostallee", coordinates: [6.6502, 49.7556], parkingType: "garage" },
  ParkPlaza: {
    name: "Parkhaus Park Plaza",
    coordinates: [6.6386, 49.7569],
    parkingType: "garage",
  },
};

interface TrierXmlEnvelope {
  parken?: {
    datum?: unknown;
    uhrzeit?: unknown;
    parkhaus?: TrierXmlEntry | TrierXmlEntry[];
  };
}

interface TrierXmlEntry {
  phname?: unknown;
  phstate?: unknown;
  shortmax?: unknown;
  shortfree?: unknown;
  timeopen?: unknown;
  timeclose?: unknown;
}

function xmlInt(value: unknown): number | undefined {
  const str = xmlText(value);
  if (str === undefined) return undefined;
  const n = Number.parseInt(str.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

function mapState(phstate: number | undefined): "open" | "closed" | "unknown" {
  if (phstate === 1 || phstate === 2) return "open";
  if (phstate === 0) return "closed";
  return "unknown";
}

/**
 * SWT's envelope timestamp is `<datum>DD.MM.YYYY</datum><uhrzeit>HH:MM:SS</uhrzeit>`
 * in Europe/Berlin local time. Treat as UTC for staleness purposes — at worst
 * we're 1–2 hours off, comfortably inside the 30-minute staleness window.
 */
function buildAsOf(envelope: TrierXmlEnvelope["parken"]): string {
  const datum = xmlText(envelope?.datum);
  const uhrzeit = xmlText(envelope?.uhrzeit);
  if (!datum || !uhrzeit) return new Date().toISOString();
  const dateMatch = datum.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const timeMatch = uhrzeit.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch || !timeMatch) return new Date().toISOString();
  const [, dStr, mStr, yStr] = dateMatch;
  const [, hStr, minStr, secStr] = timeMatch;
  const date = new Date(
    Date.UTC(
      Number(yStr),
      Number(mStr) - 1,
      Number(dStr),
      Number(hStr),
      Number(minStr),
      secStr ? Number(secStr) : 0,
    ),
  );
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export const parseTrierDeBundled: PoiBundledParseFn = (buffer, { log }) => {
  // The feed advertises ISO-8859-1; node Buffers default to UTF-8 decode.
  // The actual byte content (digit-heavy, ASCII-safe names) is stable under
  // both encodings — we use UTF-8 to keep parsing consistent with the rest
  // of the stack.
  const text = buffer.toString("utf-8");

  let envelope: TrierXmlEnvelope;
  try {
    envelope = parseXmlDocument(text) as TrierXmlEnvelope;
  } catch (err) {
    log.warn("trier-de: failed to parse XML", { error: (err as Error).message });
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  const root = envelope.parken;
  if (!root) return { static: [], live: new Map<string, PoiLiveState>() };

  const entries = Array.isArray(root.parkhaus)
    ? root.parkhaus
    : root.parkhaus
      ? [root.parkhaus]
      : [];

  const asOf = buildAsOf(root);
  const staticRows: PoiRow[] = [];
  const live = new Map<string, PoiLiveState>();

  for (const entry of entries) {
    const phname = xmlText(entry.phname)?.trim();
    if (!phname) continue;
    const facility = TRIER_FACILITIES[phname];
    if (!facility) {
      // Unknown short code — keep telemetry visible so a maintainer can add it.
      log.warn("trier-de: unknown phname, skipping", { phname });
      continue;
    }

    const capacity = xmlInt(entry.shortmax);
    const freeSpaces = xmlInt(entry.shortfree);
    const phstate = xmlInt(entry.phstate);
    const timeOpen = xmlText(entry.timeopen)?.trim();
    const timeClose = xmlText(entry.timeclose)?.trim();
    const [lng, lat] = facility.coordinates;

    // Emit OSM `opening_hours` syntax (https://wiki.openstreetmap.org/wiki/Key:opening_hours)
    // — language-neutral and localisable downstream via opening_hours.js,
    // unlike the German "Mo–So: durchgehend" idiom SWT uses internally.
    //
    // `00:00`–`24:00` is the SWT convention for 24/7.
    let openingHours: string | undefined;
    if (timeOpen && timeClose) {
      openingHours =
        timeOpen === "00:00" && (timeClose === "24:00" || timeClose === "00:00")
          ? "24/7"
          : `Mo-Su ${timeOpen}-${timeClose}`;
    }

    staticRows.push({
      poiId: phname,
      lng,
      lat,
      payload: {
        coordinates: facility.coordinates,
        name: facility.name,
        parkingType: facility.parkingType,
        capacity: capacity != null && capacity > 0 ? capacity : undefined,
        fee: "paid",
        access: "public",
        operator: "Stadtwerke Trier",
        openingHours,
      },
    });

    if (freeSpaces != null || phstate != null) {
      live.set(phname, {
        asOf,
        freeSpaces,
        state: mapState(phstate),
      });
    }
  }

  return { static: staticRows, live };
};
