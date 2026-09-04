import z from "zod/v4";

/** The only managed Dawarich runtime accepted by the controller. */
export const DAWARICH_SUPPORTED_IMAGE = "freikin/dawarich:1.10.3" as const;
export const DAWARICH_SUPPORTED_IMAGE_DIGEST =
  "sha256:d7457e7b27a9992f2fdd367fe22a515b1b44fc6e0cfb7a68f3c69c439c465a6b" as const;
export const DAWARICH_SUPPORTED_COMMIT = "da551a0e32f67b4d8ac6d50132c26634d6ad29a4" as const;
export const DAWARICH_PROTOCOL_VERSION = 1 as const;
export const DAWARICH_TAR_MEDIA_TYPE = "application/vnd.openmapx.dawarich-subject-tar.v1" as const;
/** SHA-256 of the reviewed 1.10.3 ownership/schema projection.  The Ruby
 * collector emits this value only after validating the live Rails schema;
 * accepting a different digest would make a changed source look complete. */
export const DAWARICH_EXPECTED_SCHEMA_FINGERPRINT =
  "cddd7f3971bf07ffdcc51909714d90c0d476644e414c68aa9613a601cf4bc8f1" as const;

const subjectId = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !containsUnsafeControlCharacters(value), {
    message: "subject identifier contains control characters",
  });
const requestId = z.string().uuid();
const isoDate = z.iso.datetime({ offset: true });

function containsUnsafeControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export const dawarichSubjectRequestV1Schema = z
  .object({
    version: z.literal(1),
    requestId,
    openmapxSubjectId: subjectId,
    expectedDawarichUserId: z.number().int().positive().nullable(),
    cutoff: isoDate,
    rights: z
      .array(z.enum(["access", "portability"]))
      .min(1)
      .max(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.rights).size !== value.rights.length) {
      ctx.addIssue({
        code: "custom",
        path: ["rights"],
        message: "rights must not contain duplicates",
      });
    }
  });
export type DawarichSubjectRequestV1 = z.infer<typeof dawarichSubjectRequestV1Schema>;

export const DAWARICH_SOURCE_ENTRY_IDS = [
  "source-manifest",
  "account",
  "settings",
  "areas",
  "places",
  "tags",
  "taggings",
  "imports",
  "export-records",
  "trips",
  "notifications",
  "points",
  "visits",
  "stats",
  "tracks",
  "track-segments",
  "digests",
  "raw-archives",
  "flights",
  "notes",
  "posters",
  "shared-links",
  "attachments",
  "rich-text",
  "family",
] as const;
export type DawarichFixedSourceEntryId = (typeof DAWARICH_SOURCE_ENTRY_IDS)[number];

/** Dynamic members are still part of the fixed v1 protocol.  Their logical
 * identifiers contain only a content-derived opaque id (or a UTC month), so a
 * caller can never choose an archive path or smuggle a filename through the
 * source-part boundary. */
export type DawarichDynamicSourceEntryId =
  | `import-file-${string}.${string}`
  | `raw-file-${string}.${string}`
  | `points-${string}-${string}`;
export type DawarichSourceEntryId = DawarichFixedSourceEntryId | DawarichDynamicSourceEntryId;

export const DAWARICH_SOURCE_PATHS: Readonly<Record<DawarichSourceEntryId, string>> = Object.freeze(
  {
    "source-manifest": "dawarich/source-manifest.json",
    account: "dawarich/account.json",
    settings: "dawarich/settings.json",
    areas: "dawarich/areas.jsonl",
    places: "dawarich/places.jsonl",
    tags: "dawarich/tags.jsonl",
    taggings: "dawarich/taggings.jsonl",
    imports: "dawarich/imports.jsonl",
    "export-records": "dawarich/export-records.jsonl",
    trips: "dawarich/trips.jsonl",
    notifications: "dawarich/notifications.jsonl",
    points: "dawarich/points.jsonl",
    visits: "dawarich/visits.jsonl",
    stats: "dawarich/stats.jsonl",
    tracks: "dawarich/tracks.jsonl",
    "track-segments": "dawarich/track-segments.jsonl",
    digests: "dawarich/digests.jsonl",
    "raw-archives": "dawarich/raw-archives.jsonl",
    flights: "dawarich/flights.jsonl",
    notes: "dawarich/notes.jsonl",
    posters: "dawarich/posters.jsonl",
    "shared-links": "dawarich/shared-links.jsonl",
    attachments: "dawarich/attachments.jsonl",
    "rich-text": "dawarich/rich-text.jsonl",
    family: "dawarich/family.jsonl",
  },
);

export const dawarichSourceManifestEntrySchema = z
  .object({
    id: z.union([
      z.enum(DAWARICH_SOURCE_ENTRY_IDS),
      z.string().regex(/^import-file-[a-f0-9]{64}\.[a-z0-9]{1,16}$/),
      z.string().regex(/^raw-file-[a-f0-9]{64}\.[a-z0-9]{1,16}$/),
      z.string().regex(/^points-\d{4}-(0[1-9]|1[0-2])$/),
    ]),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(2 * 1024 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    records: z.number().int().nonnegative().max(10_000_000).nullable(),
    article15: z.boolean(),
    portability: z.boolean(),
    redactionCodes: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/)).max(32),
  })
  .strict();

export const dawarichSourceManifestV1Schema = z
  .object({
    version: z.literal(1),
    image: z.string().min(1).max(256),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    upstreamCommit: z.string().regex(/^[a-f0-9]{40}$/),
    subjectUserIdDigest: z.string().regex(/^[a-f0-9]{64}$/),
    collectorContract: z.literal("openmapx-subject-export-v1"),
    cutoff: isoDate,
    snapshotAt: isoDate,
    schemaFingerprint: z.literal(DAWARICH_EXPECTED_SCHEMA_FINGERPRINT),
    schemaRelations: z
      .array(
        z
          .object({
            entry: z.string().min(1).max(64),
            model: z.string().min(1).max(128),
            available: z.boolean().optional(),
            columns: z.array(z.string().min(1).max(128)).max(512).optional(),
            foreignKey: z.string().min(1).max(64).nullable().optional(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    entries: z.array(dawarichSourceManifestEntrySchema).max(64),
    warnings: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/)).max(64),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.imageDigest !== DAWARICH_SUPPORTED_IMAGE_DIGEST ||
      value.upstreamCommit !== DAWARICH_SUPPORTED_COMMIT
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["imageDigest"],
        message: "unsupported managed Dawarich compatibility tuple",
      });
    }
    const seen = new Set<string>();
    value.entries.forEach((entry, index) => {
      if (seen.has(entry.id))
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "id"],
          message: "duplicate entry",
        });
      seen.add(entry.id);
    });
  });
export type DawarichSourceManifestV1 = z.infer<typeof dawarichSourceManifestV1Schema>;

export const DAWARICH_ERROR_CODES = [
  "not_configured",
  "not_found",
  "identity_mismatch",
  "ambiguous_identity",
  "unsupported_version",
  "schema_mismatch",
  "limit_exceeded",
  "timeout",
  "collector_failed",
  "busy",
] as const;
export type DawarichErrorCode = (typeof DAWARICH_ERROR_CODES)[number];

export const dawarichErrorResponseSchema = z
  .object({ version: z.literal(1), requestId, error: z.enum(DAWARICH_ERROR_CODES) })
  .strict();

const DYNAMIC_IMPORT_PATH = /^dawarich\/import-files\/([a-f0-9]{64})\.([a-z0-9]{1,16})$/;
const DYNAMIC_RAW_PATH = /^dawarich\/raw-files\/([a-f0-9]{64})\.([a-z0-9]{1,16})$/;
const DYNAMIC_POINTS_PATH = /^dawarich\/points\/(\d{4})\/(0[1-9]|1[0-2])\.jsonl$/;

export function dawarichEntryIdForPath(path: string): DawarichSourceEntryId | null {
  for (const id of DAWARICH_SOURCE_ENTRY_IDS) if (DAWARICH_SOURCE_PATHS[id] === path) return id;
  const importMatch = DYNAMIC_IMPORT_PATH.exec(path);
  if (importMatch) return `import-file-${importMatch[1]}.${importMatch[2]}`;
  const rawMatch = DYNAMIC_RAW_PATH.exec(path);
  if (rawMatch) return `raw-file-${rawMatch[1]}.${rawMatch[2]}`;
  const pointsMatch = DYNAMIC_POINTS_PATH.exec(path);
  if (pointsMatch) return `points-${pointsMatch[1]}-${pointsMatch[2]}`;
  return null;
}

export function dawarichSourcePathForEntryId(id: DawarichSourceEntryId): string | null {
  if (id in DAWARICH_SOURCE_PATHS) return DAWARICH_SOURCE_PATHS[id as DawarichFixedSourceEntryId];
  const importMatch = /^import-file-([a-f0-9]{64})\.([a-z0-9]{1,16})$/.exec(id);
  if (importMatch) return `dawarich/import-files/${importMatch[1]}.${importMatch[2]}`;
  const rawMatch = /^raw-file-([a-f0-9]{64})\.([a-z0-9]{1,16})$/.exec(id);
  if (rawMatch) return `dawarich/raw-files/${rawMatch[1]}.${rawMatch[2]}`;
  const pointsMatch = /^points-(\d{4})-(0[1-9]|1[0-2])$/.exec(id);
  if (pointsMatch) return `dawarich/points/${pointsMatch[1]}/${pointsMatch[2]}.jsonl`;
  return null;
}

export function isDawarichSourceEntryId(value: string): value is DawarichSourceEntryId {
  return dawarichSourcePathForEntryId(value as DawarichSourceEntryId) !== null;
}

export function isDawarichPortableEntryId(id: DawarichSourceEntryId): boolean {
  return (
    id === "areas" ||
    id === "places" ||
    id === "imports" ||
    id === "points" ||
    id === "raw-archives" ||
    id === "flights" ||
    id === "notes" ||
    /^import-file-[a-f0-9]{64}\.[a-z0-9]{1,16}$/.test(id) ||
    /^raw-file-[a-f0-9]{64}\.[a-z0-9]{1,16}$/.test(id) ||
    /^points-\d{4}-(0[1-9]|1[0-2])$/.test(id)
  );
}

export function isSupportedDawarichRuntime(value: {
  image: string;
  digest: string;
  commit: string;
}): boolean {
  return (
    value.image === DAWARICH_SUPPORTED_IMAGE &&
    value.digest === DAWARICH_SUPPORTED_IMAGE_DIGEST &&
    value.commit === DAWARICH_SUPPORTED_COMMIT
  );
}
