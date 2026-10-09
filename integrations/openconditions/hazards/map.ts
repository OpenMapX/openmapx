import type {
  FireDensityCell,
  FireInstrument,
  FirePixel,
  HazardAlert,
  NaturalHazard,
  NaturalHazardType,
} from "@openmapx/integration-framework";
import {
  credit,
  list,
  type Rec,
  type RecordSource,
  rec,
  sourcesOf,
  str,
} from "../features/record.js";
import type { LiveSources } from "../sources.js";

const CAP_SEVERITIES = ["Extreme", "Severe", "Moderate", "Minor", "Unknown"] as const;

const NATURAL_HAZARD_TYPES: ReadonlySet<string> = new Set<NaturalHazardType>([
  "wildfire",
  "flood",
  "smoke",
  "landslide",
  "avalanche",
  "earthquake",
  "volcanic_ash",
  "dust_storm",
  "tropical_cyclone",
  "volcano",
  "drought",
  "sea_ice",
]);

const SEVERITY_LABELS = ["minor", "moderate", "major", "critical", "unknown"] as const;

/**
 * The text of a multilingual `[{ lang, text }]` value: the first in the
 * language of `lang` (compared by primary subtag, so `de` takes `de-DE`),
 * else the first the value carries. A plain string stands for itself.
 */
export function textOf(value: unknown, lang?: string): string | undefined {
  if (typeof value === "string") return str(value);
  const texts = list(value).flatMap((t) => {
    const text = str(t["text"]);
    return text ? [{ lang: str(t["lang"]), text }] : [];
  });
  const wanted = lang?.split("-")[0]?.toLowerCase();
  const match = wanted
    ? texts.find((t) => t.lang?.split("-")[0]?.toLowerCase() === wanted)
    : undefined;
  return (match ?? texts[0])?.text;
}

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const field = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

function creditsOf(record: Rec): { ids: string[]; credits: RecordSource[] } {
  const credits = sourcesOf(record);
  return { ids: credits.map((s) => s.id), credits };
}

function capSeverityOf(value: unknown): HazardAlert["severity"] {
  const word =
    typeof value === "string" ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() : "";
  return (CAP_SEVERITIES as readonly string[]).includes(word)
    ? (word as HazardAlert["severity"])
    : "Unknown";
}

/**
 * One `alert` situation as a `HazardAlert`; null for one without a geometry
 * (an alert known only by geocodes cannot be drawn). Its notices are those
 * of the sources it names.
 */
export function situationToAlert(
  record: Rec,
  sources: LiveSources,
  lang?: string,
): HazardAlert | null {
  const location = rec(record["location"]);
  const geometry = location["geometry"];
  if (geometry === null || typeof geometry !== "object") return null;
  const cap = rec(rec(record["details"])["cap"]);
  const validity = rec(record["validity"]);
  const provenance = rec(record["provenance"]);
  const sent = str(cap["sent"]) ?? str(provenance["sourceUpdatedAt"]) ?? str(validity["start"]);
  if (sent === undefined) return null;
  const { ids, credits } = creditsOf(record);
  const notices = [...new Set(ids.flatMap((id) => sources.noticeOf(id) ?? []))];
  const type = String(record["type"]);
  return {
    id: String(record["id"]),
    ...field("groupId", str(record["groupId"])),
    type,
    ...field("subtype", str(record["subtype"])),
    geometry: geometry as GeoJSON.Geometry,
    event: textOf(cap["event"], lang) ?? type,
    ...field("headline", textOf(record["headline"], lang)),
    ...field("description", textOf(record["description"], lang)),
    ...field("instruction", textOf(record["instruction"], lang)),
    ...field("areaDescription", textOf(location["areaDescription"], lang)),
    severity: capSeverityOf(cap["severity"]),
    urgency: str(cap["urgency"]) ?? "unknown",
    certainty: str(cap["certainty"]) ?? str(record["certainty"]) ?? "unknown",
    sent,
    ...field("effective", str(cap["effective"])),
    ...field("onset", str(cap["onset"])),
    ...field("expires", str(validity["end"])),
    ...field("senderName", textOf(cap["senderName"], lang)),
    ...field("web", str(cap["web"])),
    sources: ids,
    attributions: credits.map((s) => credit(s, sources)),
    notices,
  };
}

/** The positions of a geometry's outer rings, a ring's closing position left out. */
function outerVertices(geometry: Rec): [number, number][] {
  const type = geometry["type"];
  const coordinates = geometry["coordinates"];
  const position = (p: unknown): [number, number][] =>
    Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number" ? [[p[0], p[1]]] : [];
  const ring = (r: unknown): [number, number][] => {
    const positions = Array.isArray(r) ? r.flatMap(position) : [];
    return positions.length > 1 ? positions.slice(0, -1) : positions;
  };
  switch (type) {
    case "Point":
      return position(coordinates);
    case "MultiPoint":
    case "LineString":
      return Array.isArray(coordinates) ? coordinates.flatMap(position) : [];
    case "MultiLineString":
      return Array.isArray(coordinates)
        ? coordinates.flatMap((l) => (Array.isArray(l) ? l.flatMap(position) : []))
        : [];
    case "Polygon":
      return Array.isArray(coordinates) ? ring(coordinates[0]) : [];
    case "MultiPolygon":
      return Array.isArray(coordinates)
        ? coordinates.flatMap((p) => (Array.isArray(p) ? ring(p[0]) : []))
        : [];
    case "GeometryCollection":
      return list(geometry["geometries"]).flatMap(outerVertices);
    default:
      return [];
  }
}

/**
 * Where to draw a hazard as one mark: a Point as it is, any other geometry
 * at the mean of its outer rings' vertices. A geometry whose longitudes
 * span more than half the globe crosses the antimeridian: its western
 * longitudes are taken east of 180 for the mean, and the result is folded
 * back into -180..180. Null for a geometry without a position.
 */
export function pointOf(geometry: unknown): [number, number] | null {
  const vertices = outerVertices(rec(geometry));
  if (vertices.length === 0) return null;
  const lons = vertices.map(([x]) => x);
  const crosses = Math.max(...lons) - Math.min(...lons) > 180;
  const x = vertices.reduce((sum, [lon]) => sum + (crosses && lon < 0 ? lon + 360 : lon), 0);
  const lon = x / vertices.length;
  return [
    crosses && lon > 180 ? lon - 360 : lon,
    vertices.reduce((sum, [, lat]) => sum + lat, 0) / vertices.length,
  ];
}

function severityOf(value: unknown): NaturalHazard["severity"] | undefined {
  const severity = rec(value);
  const label = str(severity["label"]);
  if (label === undefined) return undefined;
  const known = (SEVERITY_LABELS as readonly string[]).includes(label)
    ? (label as (typeof SEVERITY_LABELS)[number])
    : "unknown";
  if (
    known === "unknown" &&
    num(severity["level"]) === undefined &&
    !str(severity["declaredRaw"])
  ) {
    return undefined;
  }
  return {
    label: known,
    ...field("level", num(severity["level"])),
    ...field("declared", str(severity["declaredRaw"])),
  };
}

/**
 * One `natural_hazard` situation as a `NaturalHazard`; null for one without
 * a geometry, of a type the contract does not name, or whose geometry holds
 * no position.
 */
export function situationToNaturalHazard(
  record: Rec,
  sources: LiveSources,
  lang?: string,
): NaturalHazard | null {
  const type = String(record["type"]);
  if (!NATURAL_HAZARD_TYPES.has(type)) return null;
  const location = rec(record["location"]);
  const geometry = location["geometry"];
  if (geometry === null || typeof geometry !== "object") return null;
  const point = pointOf(geometry);
  if (point === null) return null;
  const details = rec(record["details"]);
  const validity = rec(record["validity"]);
  const provenance = rec(record["provenance"]);
  const admin = rec(location["admin"]);
  const detection = rec(details["detection"]);
  const magnitude = rec(details["magnitude"]);
  const depth = rec(details["depth"]);
  const maxWind = rec(details["maxWind"]);
  const cause = str(details["ignitionCause"]);
  const density = str(details["density"]);
  const { ids, credits } = creditsOf(record);
  const detectionFields = {
    ...field("satellite", str(detection["satellite"])),
    ...field("start", str(detection["start"])),
    ...field("end", str(detection["end"])),
  };
  return {
    id: String(record["id"]),
    type: type as NaturalHazardType,
    ...field("subtype", str(record["subtype"])),
    geometry: geometry as GeoJSON.Geometry,
    point,
    ...field("name", textOf(details["name"], lang)),
    ...field("headline", textOf(record["headline"], lang)),
    ...field("start", str(validity["start"])),
    ...field("end", str(validity["end"])),
    ended: validity["status"] === "ended",
    ...field("updatedAt", str(provenance["sourceUpdatedAt"])),
    ...field("severity", severityOf(record["severity"])),
    ...field("areaHa", num(details["areaHa"])),
    ...field("containmentPct", num(details["containmentPct"])),
    ...field("discoveredAt", str(details["discoveredAt"])),
    ...field("perimeterAt", str(details["perimeterAt"])),
    ...(cause === "natural" || cause === "human" || cause === "undetermined"
      ? { ignitionCause: cause }
      : {}),
    ...(density === "light" || density === "medium" || density === "heavy" ? { density } : {}),
    ...(Object.keys(detectionFields).length > 0 ? { detection: detectionFields } : {}),
    ...(num(magnitude["value"]) !== undefined && str(magnitude["scale"])
      ? { magnitude: { value: magnitude["value"] as number, scale: magnitude["scale"] as string } }
      : {}),
    ...(depth["unit"] === "m" ? field("depthM", num(depth["value"])) : {}),
    ...field("tsunamiFlag", bool(details["tsunamiFlag"])),
    ...field("feltReports", num(details["feltReports"])),
    ...field("mmi", num(details["mmi"])),
    ...field("reviewed", bool(details["reviewed"])),
    ...(maxWind["unit"] === "km/h" ? field("maxWindKmh", num(maxWind["value"])) : {}),
    ...field("populationAffected", num(details["populationAffected"])),
    ...field("country", str(admin["country"])),
    ...field("region", str(admin["subdivision"])),
    ...field("locality", str(admin["municipality"])),
    ...field("detailUrl", str(details["detailUrl"])),
    sources: ids,
    attributions: credits.map((s) => credit(s, sources)),
  };
}

/**
 * One `fire.frp` reading as a `FirePixel`; null for one without a position
 * or a radiative power. The instrument is the reading's own, else the one
 * of the feed it was read from.
 */
export function readingToFirePixel(record: Rec, instrument: FireInstrument): FirePixel | null {
  const geometry = rec(rec(record["location"])["geometry"]);
  const point = geometry["type"] === "Point" ? pointOf(geometry) : null;
  const result = rec(record["result"]);
  const frp = result["type"] === "quantity" ? num(result["value"]) : undefined;
  const observedAt = str(rec(record["phenomenonTime"])["instant"]);
  if (point === null || frp === undefined || observedAt === undefined) return null;
  const extras = rec(record["extras"]);
  const quality = rec(record["quality"]);
  const code = str(quality["supplierCode"])?.toLowerCase();
  const level: "low" | "nominal" | "high" | undefined =
    code === "low" || code === "l"
      ? "low"
      : code === "nominal" || code === "n"
        ? "nominal"
        : code === "high" || code === "h"
          ? "high"
          : undefined;
  const fraction = num(quality["confidence"]);
  const confidence = {
    ...field("level", level),
    ...field("percent", fraction === undefined ? undefined : Math.round(fraction * 100)),
  };
  const daynight = str(extras["daynight"]);
  const reported = str(extras["instrument"]);
  const sourceId = str(rec(record["provenance"])["sourceId"]);
  return {
    id: String(record["id"]),
    point,
    observedAt,
    frpMW: frp,
    ...field("brightnessK", num(extras["brightnessK"])),
    instrument: reported === "viirs" || reported === "modis" ? reported : instrument,
    ...field("satellite", str(extras["satellite"])),
    ...(Object.keys(confidence).length > 0 ? { confidence } : {}),
    ...(daynight === "day" || daynight === "night" ? { dayNight: daynight } : {}),
    sources: sourceId ? [sourceId] : [],
  };
}

/** The cells of a `/observations/grid` answer; a malformed cell is left out. */
export function gridCellsOf(cells: unknown): FireDensityCell[] {
  if (!Array.isArray(cells)) throw new Error("Malformed grid answer");
  return cells.flatMap((cell) => {
    if (
      !Array.isArray(cell) ||
      cell.length < 5 ||
      !cell.slice(0, 5).every((n) => num(n) !== undefined)
    ) {
      return [];
    }
    const [lon, lat, count, sum, max] = cell as number[];
    return [
      {
        point: [lon!, lat!] as [number, number],
        count: count!,
        frpSumMW: sum!,
        frpMaxMW: max!,
      },
    ];
  });
}
