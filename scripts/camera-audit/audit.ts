import { createHash } from "node:crypto";

export type Review = {
  identity: string;
  version: number;
  decision: "exclude" | "retain-unverified";
  reason: string;
};
export type AuditOptions = {
  source: string;
  capturedAt: string;
  bbox: readonly [number, number, number, number];
  review?: readonly Review[];
};
const MAX_BYTES = 5 * 1024 * 1024;
const compass = "N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split(" ");
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
function date(value: unknown, upper: number, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value))
    throw new Error(`Invalid ${label}`);
  const n = Date.parse(value);
  if (
    !Number.isFinite(n) ||
    n > upper ||
    new Date(n).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    throw new Error(`Invalid ${label}`);
  return n;
}
function directions(raw: string | undefined): number[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(";").map((x) => x.trim());
  if (values.length > 16) return undefined;
  const result: number[] = [];
  for (const v of values) {
    const index = compass.indexOf(v.toUpperCase());
    const n = index >= 0 ? index * 22.5 : /^(?:\d+(?:\.\d+)?)$/.test(v) ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > 360) return undefined;
    if (!result.includes(n % 360)) result.push(n % 360);
  }
  return result;
}
function directionEvidence(tags: Record<string, string>) {
  const primary = directions(tags.direction),
    legacy = directions(tags["camera:direction"]);
  if (
    tags.direction &&
    tags["camera:direction"] &&
    (!primary || !legacy || [...primary].sort().join(",") !== [...legacy].sort().join(","))
  )
    return { directions: [] as number[], directionStatus: "conflicting" };
  const values = tags.direction ? primary : legacy;
  return {
    directions: values ?? [],
    directionStatus: !values ? "unknown" : values.length > 1 ? "multiple" : "single",
  };
}
function distance(a: readonly number[], b: readonly number[]) {
  const rad = Math.PI / 180,
    dLat = (b[1] - a[1]) * rad,
    dLon = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
export function auditCameraSnapshot(raw: Buffer, query: Buffer, options: AuditOptions) {
  if (raw.byteLength > MAX_BYTES || query.byteLength > MAX_BYTES)
    throw new Error("Input size exceeds 5 MiB");
  const captured = date(options.capturedAt, Date.now(), "capture timestamp");
  let source: URL;
  try {
    source = new URL(options.source);
  } catch {
    throw new Error("Invalid source URL");
  }
  if (
    !["http:", "https:"].includes(source.protocol) ||
    source.username ||
    source.password ||
    source.search ||
    source.hash
  )
    throw new Error("Invalid source URL");
  const [w, s, e, n] = options.bbox;
  if (
    options.bbox.length !== 4 ||
    ![w, s, e, n].every(Number.isFinite) ||
    w < -180 ||
    e > 180 ||
    s < -90 ||
    n > 90 ||
    w >= e ||
    s >= n ||
    e - w > 1 ||
    n - s > 1
  )
    throw new Error("Invalid regional bbox");
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Invalid snapshot JSON");
  }
  if (
    !isRecord(payload) ||
    "remark" in payload ||
    !Array.isArray(payload.elements) ||
    payload.elements.length > 10000 ||
    !isRecord(payload.osm3s)
  )
    throw new Error("A complete bounded Overpass snapshot is required");
  const snapshotAt = payload.osm3s.timestamp_osm_base;
  const snapshot = date(snapshotAt, captured, "snapshot timestamp");
  const reviews = new Map<string, Review>();
  if (options.review !== undefined && !Array.isArray(options.review))
    throw new Error("Invalid review file");
  for (const r of options.review ?? []) {
    if (
      !isRecord(r) ||
      typeof r.identity !== "string" ||
      typeof r.version !== "number" ||
      !Number.isSafeInteger(r.version) ||
      r.version < 1 ||
      (r.decision !== "exclude" && r.decision !== "retain-unverified") ||
      typeof r.reason !== "string" ||
      !r.reason.trim() ||
      r.reason.length > 500 ||
      reviews.has(r.identity)
    )
      throw new Error("Invalid review entry");
    reviews.set(r.identity, r as Review);
  }
  const seen = new Set<string>();
  const rows: Array<{
    identity: string;
    version: number;
    classification: string;
    disposition: string;
    reason: string;
    objectEditedAt: string;
  }> = [];
  const features: Array<{
    type: "Feature";
    id: string;
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: {
      identity: string;
      version: number;
      objectEditedAt: string;
      directions: number[];
      directionStatus: string;
      zone: string | null;
      position: "unverified";
      physicalPresence: "unknown";
      coverage: "incomplete";
      reviewReason: string | null;
    };
  }> = [];
  const counts = {
    total: payload.elements.length,
    speedCamera: 0,
    webcam: 0,
    otherSurveillance: 0,
    other: 0,
    explicitAlpr: 0,
    eligible: 0,
    unsupportedGeometry: 0,
    excluded: 0,
  };
  for (const item of payload.elements) {
    if (
      !isRecord(item) ||
      typeof item.type !== "string" ||
      !["node", "way", "relation"].includes(item.type) ||
      typeof item.id !== "number" ||
      !Number.isSafeInteger(item.id) ||
      item.id <= 0 ||
      typeof item.version !== "number" ||
      !Number.isSafeInteger(item.version) ||
      item.version <= 0 ||
      !isRecord(item.tags) ||
      !Object.values(item.tags).every((v) => typeof v === "string")
    )
      throw new Error("Invalid snapshot object");
    date(item.timestamp, snapshot, "object edit timestamp");
    const identity = `${item.type}/${item.id}`;
    if (seen.has(identity)) throw new Error("Duplicate snapshot identity");
    seen.add(identity);
    const tags = item.tags as Record<string, string>;
    const review = reviews.get(identity);
    if (review && review.version !== item.version)
      throw new Error("Review does not match snapshot version");
    reviews.delete(identity);
    const explicit = tags.man_made === "surveillance" && tags["surveillance:type"] === "ALPR";
    const speed = tags.highway === "speed_camera",
      webcam = "contact:webcam" in tags || tags["surveillance:type"] === "webcam";
    const classification = explicit
      ? "explicitAlpr"
      : speed
        ? "speedCamera"
        : webcam
          ? "webcam"
          : tags.man_made === "surveillance"
            ? "otherSurveillance"
            : "other";
    counts[classification]++;
    let reason = "Not an explicitly tagged ALPR camera",
      disposition = "excluded";
    if (item.type !== "node") {
      counts.unsupportedGeometry++;
      reason = "Unsupported non-point geometry";
    } else {
      if (
        typeof item.lon !== "number" ||
        typeof item.lat !== "number" ||
        !Number.isFinite(item.lon) ||
        !Number.isFinite(item.lat) ||
        item.lon < w ||
        item.lon > e ||
        item.lat < s ||
        item.lat > n
      )
        throw new Error("Invalid or outside-bbox node position");
      const inactive = [
        "disused",
        "removed",
        "demolished",
        "razed",
        "abandoned",
        "construction",
        "proposed",
        "planned",
        "was",
      ].some(
        (key) =>
          tags[key] === "yes" || `${key}:man_made` in tags || `${key}:surveillance:type` in tags,
      );
      const conflict =
        speed || webcam || ["dome", "ptz", "panning"].includes(tags["camera:type"]?.toLowerCase());
      if (explicit) {
        reason = inactive
          ? "Inactive/lifecycle-tagged device"
          : conflict
            ? "Conflicting camera classification"
            : review?.decision === "exclude"
              ? review.reason
              : "Explicit ALPR tag; physical position and current presence unverified";
        if (!inactive && !conflict && review?.decision !== "exclude") {
          disposition = "eligible-unverified";
          features.push({
            type: "Feature",
            id: identity,
            geometry: { type: "Point", coordinates: [item.lon, item.lat] },
            properties: {
              identity,
              version: item.version,
              objectEditedAt: item.timestamp as string,
              ...directionEvidence(tags),
              zone: tags["surveillance:zone"] ?? null,
              position: "unverified",
              physicalPresence: "unknown",
              coverage: "incomplete",
              reviewReason: review?.reason ?? null,
            },
          });
        }
      }
    }
    if (explicit && disposition === "excluded") counts.excluded++;
    rows.push({
      identity,
      version: item.version,
      classification,
      disposition,
      reason,
      objectEditedAt: item.timestamp as string,
    });
  }
  if (reviews.size) throw new Error("Review refers to an absent snapshot identity");
  counts.eligible = features.length;
  if (features.length > 1000) throw new Error("Regional ALPR limit exceeds 1000");
  const nearbyPairs: Array<{ identities: [string, string]; distanceMetres: number }> = [];
  let nearbyPairsTruncated = false;
  pairs: for (let i = 0; i < features.length; i++)
    for (let j = i + 1; j < features.length; j++) {
      const metres = distance(features[i].geometry.coordinates, features[j].geometry.coordinates);
      if (metres <= 5) {
        if (nearbyPairs.length === 1000) {
          nearbyPairsTruncated = true;
          break pairs;
        }
        nearbyPairs.push({
          identities: [features[i].id, features[j].id],
          distanceMetres: Math.round(metres * 100) / 100,
        });
      }
    }
  const common = {
    attribution: "© OpenStreetMap contributors",
    license: "ODbL-1.0",
    licenseUrl: "https://www.openstreetmap.org/copyright",
    coverage: "incomplete",
    source: source.href,
    capturedAt: options.capturedAt,
    snapshotAt: snapshotAt as string,
    bbox: options.bbox,
    inputSha256: createHash("sha256").update(raw).digest("hex"),
    querySha256: createHash("sha256").update(query).digest("hex"),
  };
  return {
    audit: {
      schemaVersion: 1,
      ...common,
      snapshotAgeDays: (captured - snapshot) / 86400000,
      counts,
      rows,
      nearbyPairs,
      nearbyPairsTruncated,
      reviewSha256: createHash("sha256")
        .update(JSON.stringify(options.review ?? []))
        .digest("hex"),
      decisions: {
        awarenessPrototype: features.length ? "go" : "no-go",
        productionAwareness: "no-go",
        routeAvoidance: "no-go",
      },
    },
    geojson: { type: "FeatureCollection", ...common, features },
  };
}
