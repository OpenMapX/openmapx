import { z } from "zod";

export const MAX_INTAKE_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_INTAKE_TEXT_BYTES = 8192;
export const MAX_INTAKE_TEXT_LENGTH = 4096;
export const MAX_INTAKE_ITEMS = 8;
export const MAX_INTAKE_INBOX_BYTES = 20 * 1024 * 1024;
export const MAX_INTAKE_FILES_PER_SHARE = 5;
export const INTAKE_TTL_MS = 24 * 60 * 60 * 1000;
export const INTAKE_CHUNK_BYTES = 24576;
export const INTAKE_ERROR_CODES = [
  "unsupported",
  "too-large",
  "too-many",
  "inbox-full",
  "unreadable",
  "expired",
  "unavailable",
  "invalid-data",
] as const;
export const intakeIdSchema = z.string().uuid();
const header = {
  id: intakeIdSchema,
  createdAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  name: z.string().max(128),
};
export const intakeItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...header,
      kind: z.literal("file"),
      byteLength: z.number().int().min(1).max(MAX_INTAKE_FILE_BYTES),
      format: z.enum(["gpx", "geojson", "kml"]),
    })
    .strict(),
  z
    .object({
      ...header,
      kind: z.literal("text"),
      byteLength: z.number().int().min(1).max(MAX_INTAKE_TEXT_BYTES),
    })
    .strict(),
  z
    .object({
      ...header,
      kind: z.literal("error"),
      byteLength: z.literal(0),
      errorCode: z.enum(INTAKE_ERROR_CODES),
    })
    .strict(),
]);
export type IntakeItem = z.infer<typeof intakeItemSchema>;
export type IntakeErrorCode = (typeof INTAKE_ERROR_CODES)[number];
export const intakeChunkSchema = z
  .object({
    id: intakeIdSchema,
    offset: z.number().int().nonnegative().max(MAX_INTAKE_FILE_BYTES),
    data: z
      .string()
      .max(32768)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    byteLength: z.number().int().min(0).max(INTAKE_CHUNK_BYTES),
    eof: z.boolean(),
  })
  .strict();
export type IntakeChunk = z.infer<typeof intakeChunkSchema>;
export type SharedTextIntent =
  | { kind: "map"; query: string; summary: string }
  | { kind: "unsupported"; reason: "unsupported" | "too-large" };
interface Config {
  webOrigin: string;
  scheme: string;
}

function queryIntent(params: URLSearchParams, summary: string): SharedTextIntent {
  const query = `?${params.toString()}`;
  return query.length <= 2048
    ? { kind: "map", query, summary }
    : { kind: "unsupported", reason: "too-large" };
}
function search(text: string): SharedTextIntent {
  return queryIntent(new URLSearchParams({ q: text }), text);
}
function point(text: string, name = ""): SharedTextIntent | null {
  const m =
    /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)),\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\(([^\n]*)\))?$/.exec(
      text.trim(),
    );
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return { kind: "unsupported", reason: "unsupported" };
  const coords = `${lat},${lng}`;
  const label = name || m[3] || coords;
  return queryIntent(
    new URLSearchParams({
      map: `${coords},16,0,0`,
      panel: "place",
      place: `geo:${coords}`,
      at: coords,
      name: label,
    }),
    label,
  );
}
/** Interpret explicit shared data without fetching redirects or selecting an origin. */
export function classifySharedText(raw: string, config: Config): SharedTextIntent {
  if (
    typeof raw !== "string" ||
    raw.length > MAX_INTAKE_TEXT_LENGTH ||
    new TextEncoder().encode(raw).byteLength > MAX_INTAKE_TEXT_BYTES
  )
    return { kind: "unsupported", reason: "too-large" };
  const text = raw.trim();
  if (
    !text ||
    Array.from(text).some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)))
  )
    return { kind: "unsupported", reason: "unsupported" };
  const direct = point(text);
  if (direct) return direct;
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    const labels = lines.filter((s) => !/^[a-z][a-z\d+.-]*:/i.test(s));
    const link = lines.find((s) => /^[a-z][a-z\d+.-]*:/i.test(s));
    if (link && labels.length) {
      const parsed = classifySharedText(link, config);
      return parsed.kind === "map" ? parsed : search(labels.join(" "));
    }
  }
  if (!/^[a-z][a-z\d+.-]*:/i.test(text)) return search(text);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { kind: "unsupported", reason: "unsupported" };
  }
  if (url.username || url.password) return { kind: "unsupported", reason: "unsupported" };
  if (url.protocol === "geo:") {
    if (url.host || url.hash) return { kind: "unsupported", reason: "unsupported" };
    const [coords, ...attributes] = url.pathname.split(";");
    const base = point(coords);
    if (
      !base ||
      base.kind === "unsupported" ||
      attributes.some((v) => v.startsWith("crs=") && v !== "crs=wgs84")
    )
      return { kind: "unsupported", reason: "unsupported" };
    const q = url.searchParams.get("q")?.trim();
    return q ? (point(q) ?? search(q)) : base;
  }
  if (url.protocol === "https:") {
    const origin = new URL(config.webOrigin).origin;
    if (url.origin === origin && url.pathname === "/")
      return queryIntent(
        url.searchParams,
        url.searchParams.get("name") || url.searchParams.get("q") || "OpenMapX",
      );
    if (url.port) return { kind: "unsupported", reason: "unsupported" };
    if (url.hostname === "maps.apple.com") {
      const q = url.searchParams.get("q") || url.searchParams.get("address");
      return (
        point(url.searchParams.get("ll") || "", q || "") ??
        (q ? (point(q) ?? search(q)) : { kind: "unsupported", reason: "unsupported" })
      );
    }
    if (
      ["www.google.com", "google.com", "maps.google.com"].includes(url.hostname) &&
      (url.hostname === "maps.google.com" ||
        url.pathname === "/maps" ||
        url.pathname.startsWith("/maps/"))
    ) {
      const q = url.searchParams.get("query") || url.searchParams.get("q");
      if (q) return point(q) ?? search(q);
      const m = /^\/maps\/search\/([^/]+)\/?$/.exec(url.pathname);
      if (m) {
        try {
          const value = decodeURIComponent(m[1]);
          return point(value) ?? search(value);
        } catch {
          /* invalid encoding */
        }
      }
    }
    if (["openstreetmap.org", "www.openstreetmap.org"].includes(url.hostname)) {
      const lat = url.searchParams.get("mlat");
      const lng = url.searchParams.get("mlon");
      if (lat !== null && lng !== null)
        return point(`${lat},${lng}`) ?? { kind: "unsupported", reason: "unsupported" };
      const m = /^#map=\d+(?:\.\d+)?\/([+-]?[\d.]+)\/([+-]?[\d.]+)$/.exec(url.hash);
      if (m) return point(`${m[1]},${m[2]}`) ?? { kind: "unsupported", reason: "unsupported" };
    }
  }
  if (
    url.protocol === `${config.scheme.toLowerCase()}:` &&
    !url.host &&
    (url.pathname === "/" || url.pathname === "")
  )
    return queryIntent(url.searchParams, url.searchParams.get("q") || "OpenMapX");
  return { kind: "unsupported", reason: "unsupported" };
}

export const intakeListingSchema = z
  .object({
    items: z.array(intakeItemSchema).max(10),
    canApply: z.boolean(),
    scheme: z.string().regex(/^[a-z][a-z0-9+.-]{0,100}$/),
  })
  .strict();
