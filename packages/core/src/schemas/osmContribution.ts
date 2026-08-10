/**
 * The single request/response contract for OpenStreetMap place contributions.
 *
 * The browser may express only small *semantic* operations here — never a raw
 * OSM key, a tag map, geometry, or a complete element. The server owns the tag
 * allowlist and translates these operations through a versioned policy, so a
 * new editable fact cannot be introduced from the client side alone.
 *
 * Both the API and the web app parse against these schemas: `.strict()` object
 * boundaries mean an unexpected property is a rejection, not silently dropped.
 */
import { z } from "zod";

/** OSM limits tag keys and values to 255 Unicode characters. */
export const OSM_MAX_TAG_CODE_POINTS = 255;
/** Changeset comments share the tag-value limit; the lower bound is ours. */
export const OSM_MIN_COMMENT_CODE_POINTS = 10;
export const OSM_MAX_COMMENT_CODE_POINTS = 255;
export const OSM_MIN_NOTE_CODE_POINTS = 10;
export const OSM_MAX_NOTE_CODE_POINTS = 1_000;
export const OSM_MIN_EVIDENCE_DETAIL_CODE_POINTS = 3;
export const OSM_MAX_EVIDENCE_DETAIL_CODE_POINTS = 120;
/** Upper bound on how many curated fields one changeset may touch. */
export const OSM_MAX_CHANGES_PER_SUBMISSION = 8;

/**
 * Count Unicode code points, not UTF-16 code units. OSM's 255-character limit
 * is expressed in characters, so `"😀".length === 2` must never become policy.
 */
export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

/**
 * C0 (including tab/newline), DEL and C1 controls are rejected everywhere a
 * human string is accepted. Written as a code-point scan rather than a regex
 * so the ranges stay readable and no literal control byte enters the source.
 */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f) return true;
    if (code >= 0x7f && code <= 0x9f) return true;
  }
  return false;
}

/** Trimmed, control-free text bounded by Unicode code points. */
function boundedText(min: number, max: number) {
  return z
    .string()
    .trim()
    .refine((value) => !hasControlCharacters(value), {
      message: "must not contain control characters",
    })
    .refine((value) => countCodePoints(value) >= min, {
      message: `must be at least ${min} characters`,
    })
    .refine((value) => countCodePoints(value) <= max, {
      message: `must be at most ${max} characters`,
    });
}

export const osmElementTypeSchema = z.enum(["node", "way", "relation"]);
export type OsmElementType = z.infer<typeof osmElementTypeSchema>;

/** Includes `unknown`: a closed way whose area/line semantics cannot be proven. */
export const osmGeometrySchema = z.enum(["point", "line", "area", "relation", "unknown"]);
export type OsmGeometry = z.infer<typeof osmGeometrySchema>;

/** Geometries a preset may be matched against. Excludes `unknown` by design. */
export const osmEditorGeometrySchema = z.enum(["point", "line", "area", "relation"]);
export type OsmEditorGeometry = z.infer<typeof osmEditorGeometrySchema>;

export const osmElementRefSchema = z
  .object({
    type: osmElementTypeSchema,
    id: z.coerce.number().int().positive().safe(),
  })
  .strict();
export type OsmElementRef = z.infer<typeof osmElementRefSchema>;

export const osmContributionScopeSchema = z.enum(["write_api", "write_notes"]);
export type OsmContributionScope = z.infer<typeof osmContributionScopeSchema>;

export const osmLocaleSchema = z.enum(["en", "de"]);
export type OsmContributionLocale = z.infer<typeof osmLocaleSchema>;

export const osmEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("survey") }).strict(),
  z.object({ kind: z.literal("signage") }).strict(),
  z.object({ kind: z.literal("officialWebsite") }).strict(),
  z
    .object({
      kind: z.literal("otherCompatible"),
      detail: boundedText(OSM_MIN_EVIDENCE_DETAIL_CODE_POINTS, OSM_MAX_EVIDENCE_DETAIL_CODE_POINTS),
    })
    .strict(),
]);
export type OsmEvidence = z.infer<typeof osmEvidenceSchema>;

export const osmScalarEditableFieldSchema = z.enum([
  "name",
  "openingHours",
  "phone",
  "email",
  "website",
  "wheelchair",
]);
export type OsmScalarEditableField = z.infer<typeof osmScalarEditableFieldSchema>;

/**
 * Semantic address components. These are *not* OSM keys: the server maps each
 * to the single `addr:*` key it owns, and only for keys already present on the
 * exact element.
 */
export const osmAddressFieldSchema = z.enum([
  "houseNumber",
  "street",
  "place",
  "postcode",
  "city",
  "state",
  "country",
  "unit",
  "floor",
  "door",
]);
export type OsmAddressField = z.infer<typeof osmAddressFieldSchema>;

const osmScalarValueSchema = boundedText(1, OSM_MAX_TAG_CODE_POINTS);

/** Deletion is explicit: an empty text input is never an implicit removal. */
export const osmAddressValueOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), value: osmScalarValueSchema }).strict(),
  z.object({ action: z.literal("remove") }).strict(),
]);
export type OsmAddressValueOperation = z.infer<typeof osmAddressValueOperationSchema>;

export const osmAddressPatchSchema = z
  .object({
    houseNumber: osmAddressValueOperationSchema.optional(),
    street: osmAddressValueOperationSchema.optional(),
    place: osmAddressValueOperationSchema.optional(),
    postcode: osmAddressValueOperationSchema.optional(),
    city: osmAddressValueOperationSchema.optional(),
    state: osmAddressValueOperationSchema.optional(),
    country: osmAddressValueOperationSchema.optional(),
    unit: osmAddressValueOperationSchema.optional(),
    floor: osmAddressValueOperationSchema.optional(),
    door: osmAddressValueOperationSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((entry) => entry !== undefined), {
    message: "at least one address component is required",
  });
export type OsmAddressPatch = z.infer<typeof osmAddressPatchSchema>;

/**
 * Preset ids are slash-separated schema identifiers such as `amenity/cafe`.
 * The bound keeps an unknown id from becoming an unbounded lookup key.
 */
export const osmPresetIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_:./-]*$/, "invalid preset id");

export const osmFieldChangeSchema = z.union([
  z
    .object({
      field: z.literal("category"),
      action: z.literal("set"),
      presetId: osmPresetIdSchema,
    })
    .strict(),
  z
    .object({
      field: z.literal("address"),
      action: z.literal("patch"),
      value: osmAddressPatchSchema,
    })
    .strict(),
  z
    .object({
      field: osmScalarEditableFieldSchema,
      action: z.literal("set"),
      value: osmScalarValueSchema,
    })
    .strict(),
  z
    .object({
      field: osmScalarEditableFieldSchema,
      action: z.literal("remove"),
    })
    .strict(),
]);
export type OsmFieldChange = z.infer<typeof osmFieldChangeSchema>;

/** Every editable field discriminant, used for uniqueness and UI ordering. */
export const osmEditableFieldNameSchema = z.enum([
  "name",
  "category",
  "address",
  "openingHours",
  "phone",
  "email",
  "website",
  "wheelchair",
]);
export type OsmEditableFieldName = z.infer<typeof osmEditableFieldNameSchema>;

export const osmFieldChangesSchema = z
  .array(osmFieldChangeSchema)
  .min(1)
  .max(OSM_MAX_CHANGES_PER_SUBMISSION)
  .superRefine((changes, ctx) => {
    const seen = new Set<string>();
    changes.forEach((change, index) => {
      if (seen.has(change.field)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "field"],
          message: `duplicate change for field "${change.field}"`,
        });
        return;
      }
      seen.add(change.field);
    });
  });

export const osmIdempotencyKeySchema = z.uuid();

export const osmContributionPreviewRequestSchema = z
  .object({
    ref: osmElementRefSchema,
    baseVersion: z.number().int().positive().safe(),
    changes: osmFieldChangesSchema,
    locale: osmLocaleSchema,
    idempotencyKey: osmIdempotencyKeySchema,
  })
  .strict();
export type OsmContributionPreviewRequest = z.infer<typeof osmContributionPreviewRequestSchema>;

export const osmContributionPublishRequestSchema = z
  .object({
    ref: osmElementRefSchema,
    baseVersion: z.number().int().positive().safe(),
    changes: osmFieldChangesSchema,
    locale: osmLocaleSchema,
    idempotencyKey: osmIdempotencyKeySchema,
    evidence: osmEvidenceSchema,
    reviewRequested: z.boolean(),
    // Always supplied by the person. Never derived from `changes`.
    comment: boundedText(OSM_MIN_COMMENT_CODE_POINTS, OSM_MAX_COMMENT_CODE_POINTS),
  })
  .strict();
export type OsmContributionPublishRequest = z.infer<typeof osmContributionPublishRequestSchema>;

/**
 * A Note carries no version and no coordinates: the server re-reads the exact
 * element and uses its own validated centre.
 */
export const osmNoteRequestSchema = z
  .object({
    ref: osmElementRefSchema,
    text: boundedText(OSM_MIN_NOTE_CODE_POINTS, OSM_MAX_NOTE_CODE_POINTS),
    idempotencyKey: osmIdempotencyKeySchema,
  })
  .strict();
export type OsmNoteRequest = z.infer<typeof osmNoteRequestSchema>;

export const osmCategorySearchQuerySchema = z
  .object({
    type: osmElementTypeSchema,
    id: z.coerce.number().int().positive().safe(),
    geometry: osmEditorGeometrySchema,
    locale: osmLocaleSchema,
    q: z.string().trim().min(1).max(100),
    limit: z.coerce.number().int().min(1).max(20).optional(),
  })
  .strict();
export type OsmCategorySearchQuery = z.infer<typeof osmCategorySearchQuerySchema>;

const httpsUrlSchema = z.url();

export const osmPublicAccountSchema = z
  .object({
    id: z.number().int().positive().safe(),
    displayName: z.string().min(1).max(255),
    profileUrl: httpsUrlSchema,
  })
  .strict();
export type OsmPublicAccount = z.infer<typeof osmPublicAccountSchema>;

export const osmContributionCapabilitiesSchema = z
  .object({
    enabled: z.boolean(),
    directEditingEnabled: z.boolean(),
    linked: z.boolean(),
    canWriteApi: z.boolean(),
    canWriteNotes: z.boolean(),
    contributorTermsAgreed: z.boolean(),
    activeBlock: z.boolean(),
    account: osmPublicAccountSchema.optional(),
    requiredScopes: z.array(osmContributionScopeSchema).max(2),
    actions: z
      .object({
        reauthorize: z.boolean(),
        contributorTermsUrl: httpsUrlSchema.optional(),
        accountMessagesUrl: httpsUrlSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type OsmContributionCapabilities = z.infer<typeof osmContributionCapabilitiesSchema>;

/** Closed reason codes so the UI never renders an upstream string. */
export const osmFieldDisabledReasonSchema = z.enum([
  "ALIAS_CONFLICT",
  "NO_ADDRESS_ON_ELEMENT",
  "GEOMETRY_UNKNOWN",
  "CATEGORY_AMBIGUOUS",
  "CATEGORY_UNSUPPORTED",
  "LIFECYCLE_STATE",
  "DIRECT_EDITING_DISABLED",
  "VALUE_TOO_LONG",
]);
export type OsmFieldDisabledReason = z.infer<typeof osmFieldDisabledReasonSchema>;

const osmFieldBaseShape = {
  label: z.string().min(1).max(255),
  enabled: z.boolean(),
  disabledReason: osmFieldDisabledReasonSchema.optional(),
};

export const osmEditableFieldSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      field: osmScalarEditableFieldSchema,
      currentValue: z.string().nullable(),
      maxCodePoints: z.number().int().positive().max(OSM_MAX_TAG_CODE_POINTS),
      ...osmFieldBaseShape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("choice"),
      field: osmScalarEditableFieldSchema,
      currentValue: z.string().nullable(),
      options: z
        .array(z.object({ value: z.string().min(1), label: z.string().min(1) }).strict())
        .max(20),
      ...osmFieldBaseShape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("category"),
      field: z.literal("category"),
      currentPresetId: z.string().nullable(),
      currentPresetName: z.string().nullable(),
      ...osmFieldBaseShape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("address"),
      field: z.literal("address"),
      entries: z
        .array(
          z
            .object({
              key: osmAddressFieldSchema,
              label: z.string().min(1),
              currentValue: z.string(),
            })
            .strict(),
        )
        .max(10),
      ...osmFieldBaseShape,
    })
    .strict(),
]);
export type OsmEditableField = z.infer<typeof osmEditableFieldSchema>;

export const osmPresetMatchStatusSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("matched"),
      presetId: z.string().min(1),
      name: z.string().min(1),
      iconKey: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ status: z.literal("ambiguous") }).strict(),
  z
    .object({
      status: z.literal("unsupported"),
      reason: z.enum(["WILDCARD_ONLY", "DEPRECATED", "LIFECYCLE", "GEOMETRY", "NO_MATCH"]),
    })
    .strict(),
]);
export type OsmPresetMatchStatus = z.infer<typeof osmPresetMatchStatusSchema>;

export const osmContributionContextSchema = z
  .object({
    ref: osmElementRefSchema,
    version: z.number().int().positive().safe(),
    geometry: osmGeometrySchema,
    changesetId: z.number().int().positive().safe().optional(),
    /** Server-computed display centre; `null` disables Note creation. */
    center: z.object({ lat: z.number(), lon: z.number() }).strict().nullable(),
    /** The live OSM `name` tag, used only to title the editor shell. */
    displayName: z.string().nullable(),
    currentPreset: osmPresetMatchStatusSchema,
    fields: z.array(osmEditableFieldSchema).max(16),
    advancedEditorUrl: httpsUrlSchema,
    elementUrl: httpsUrlSchema,
    fetchedAt: z.iso.datetime(),
  })
  .strict();
export type OsmContributionContext = z.infer<typeof osmContributionContextSchema>;

export const osmCategorySuggestionSchema = z
  .object({
    presetId: z.string().min(1),
    name: z.string().min(1),
    iconKey: z.string().min(1).optional(),
    geometry: z.array(osmEditorGeometrySchema).min(1),
  })
  .strict();
export type OsmCategorySuggestion = z.infer<typeof osmCategorySuggestionSchema>;

export const osmPreviewWarningSchema = z.enum([
  "CATEGORY_TRANSITION",
  "VALUE_REMOVED",
  "REVIEW_RECOMMENDED",
]);
export type OsmPreviewWarning = z.infer<typeof osmPreviewWarningSchema>;

export const osmSemanticDiffSchema = z
  .object({
    field: osmEditableFieldNameSchema,
    label: z.string().min(1),
    action: z.enum(["set", "remove", "patch"]),
    before: z.string().nullable(),
    after: z.string().nullable(),
  })
  .strict();
export type OsmSemanticDiff = z.infer<typeof osmSemanticDiffSchema>;

/** The exact, server-authoritative tag result. Response-only — never a request. */
export const osmTagDiffSchema = z
  .object({
    add: z.array(z.object({ key: z.string(), value: z.string() }).strict()),
    replace: z.array(z.object({ key: z.string(), from: z.string(), to: z.string() }).strict()),
    remove: z.array(z.object({ key: z.string(), value: z.string() }).strict()),
  })
  .strict();
export type OsmTagDiff = z.infer<typeof osmTagDiffSchema>;

export const osmContributionPreviewSchema = z
  .object({
    ref: osmElementRefSchema,
    baseVersion: z.number().int().positive().safe(),
    changes: z.array(osmSemanticDiffSchema).min(1),
    tagDiff: osmTagDiffSchema,
    warnings: z.array(osmPreviewWarningSchema),
    requiresReview: z.boolean(),
  })
  .strict();
export type OsmContributionPreview = z.infer<typeof osmContributionPreviewSchema>;

export const osmContributionPublishResultSchema = z
  .object({
    ref: osmElementRefSchema,
    version: z.number().int().positive().safe(),
    changesetId: z.number().int().positive().safe(),
    changesetUrl: httpsUrlSchema,
    elementUrl: httpsUrlSchema,
    publishedAt: z.iso.datetime(),
  })
  .strict();
export type OsmContributionPublishResult = z.infer<typeof osmContributionPublishResultSchema>;

export const osmNoteResultSchema = z
  .object({
    noteId: z.number().int().positive().safe(),
    noteUrl: httpsUrlSchema,
    status: z.enum(["open", "closed"]),
  })
  .strict();
export type OsmNoteResult = z.infer<typeof osmNoteResultSchema>;

export const osmContributionErrorCodeSchema = z.enum([
  "FEATURE_DISABLED",
  "DIRECT_EDITING_DISABLED",
  "OSM_ACCOUNT_NOT_LINKED",
  "OSM_REAUTHORIZATION_REQUIRED",
  "CONTRIBUTOR_TERMS_REQUIRED",
  "OSM_ACCOUNT_BLOCKED",
  "ELEMENT_NOT_FOUND",
  "ELEMENT_DELETED",
  "ELEMENT_NOT_ELIGIBLE",
  "FIELD_NOT_EDITABLE",
  "INVALID_CHANGE",
  "EMPTY_CHANGE",
  "VERSION_CONFLICT",
  "SUBMISSION_IN_PROGRESS",
  "RATE_LIMITED",
  "AMBIGUOUS_RESULT",
  "OSM_UNAVAILABLE",
  "UPSTREAM_INVALID",
]);
export type OsmContributionErrorCode = z.infer<typeof osmContributionErrorCodeSchema>;

export const osmContributionErrorBodySchema = z
  .object({
    code: osmContributionErrorCodeSchema,
    /** Already user-safe: never an upstream body. */
    message: z.string().min(1).max(500),
    retryAfterSeconds: z.number().int().min(0).max(86_400).optional(),
    /** Fresh live context, supplied on `VERSION_CONFLICT`. */
    context: osmContributionContextSchema.optional(),
    /** Trusted OSM links for an ambiguous post-send state. */
    inspect: z
      .object({
        changesetUrl: httpsUrlSchema.optional(),
        elementUrl: httpsUrlSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type OsmContributionErrorBody = z.infer<typeof osmContributionErrorBodySchema>;

const CANONICAL_OSM_ID = /^(node|way|relation)\/([1-9][0-9]{0,18})$/;

/**
 * Parse the canonical `Place.ids.osm` form. Deliberately strict: URLs, query
 * strings, `osm:` prefixes, leading zeros and unsafe integers all return null
 * so an ineligible place simply never offers the contribution entry.
 */
export function parseOsmElementId(value: string | undefined | null): OsmElementRef | null {
  if (typeof value !== "string") return null;
  const match = CANONICAL_OSM_ID.exec(value);
  if (!match) return null;
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { type: match[1] as OsmElementType, id };
}
