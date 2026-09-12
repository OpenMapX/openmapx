import { z } from "zod";
import type {
  PublishedRoadRestrictionDetailsV1,
  RoadConditionEvent,
} from "../types/roadConditions";

/**
 * Wire-shape validation for the normalized restriction contract, version 1.
 *
 * This module validates; it never interprets. Temporal state, freshness and the
 * next transition are computed by OpenConditions and only read here, because
 * the browser has neither the source semantics nor the source's clock. An
 * envelope that fails validation becomes an explicit unsupported marker rather
 * than an absent restriction: an uninterpretable claim about which vehicles a
 * condition applies to is not the same as no claim at all.
 */

const TEXT_LIMIT = 4096;

const boundedText = z.string().max(TEXT_LIMIT);
const instant = z
  .string()
  .refine((v) => /(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)), {
    message: "expected an ISO instant with an explicit zone",
  });
const httpUrl = z.string().refine((v) => /^https?:\/\/\S+$/i.test(v), {
  message: "expected an http(s) URL",
});

/** Bounded plain-JSON token bag; never a raw source record. */
const tokens = z.custom<Record<string, unknown>>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  { message: "expected a token object" },
);

const scheduleSchema = z.object({
  repeatFrequency: z.string().optional(),
  repeatCount: z.number().int().nonnegative().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  duration: z.string().optional(),
  byDay: z.array(z.string()).optional(),
  byMonth: z.array(z.number().int()).optional(),
  byMonthDay: z.array(z.number().int()).optional(),
  exceptDate: z.array(z.string()).optional(),
  scheduleTimezone: z.string().min(1),
});

const issueSchema = z.object({
  code: z.enum([
    "unsupported_type",
    "unsupported_unit",
    "unsupported_operator",
    "invalid_value",
    "invalid_window",
    "unsupported_schedule",
    "unsupported_status",
    "unknown_vehicle",
    "compound_condition",
    "conflicting_direction",
  ]),
  factId: z.string().min(1).nullable(),
  sourcePath: z.string(),
  sourceText: boundedText.optional(),
  sourceTokens: tokens.optional(),
  truncated: z.literal(true).optional(),
});

const sourceSchema = z.object({
  sourceId: z.string().min(1),
  recordId: z.string().min(1),
  recordVersion: z.string().min(1).nullable(),
  sourceUpdatedAt: instant.nullable(),
  feedUrls: z.array(httpUrl),
  publisher: z.string().min(1),
  license: z.string().min(1),
  licenseUrl: httpUrl,
  attribution: z.string().min(1),
  modificationNotice: z.string().min(1),
  notices: z.array(boundedText).optional(),
});

const factBase = {
  id: z.string().min(1),
  state: z.enum(["active", "scheduled", "ended", "unknown"]),
  scope: z.object({
    kind: z.enum(["event_road", "roadwork_phase", "detour"]),
    phaseId: z.string().min(1).nullable(),
    locationDescription: boundedText.nullable(),
    sourceLocationRefs: tokens,
    restrictionBinding: z.literal("not_established"),
  }),
  direction: z.object({
    basis: z.enum(["road_reference", "alert_c", "openlr", "unknown"]),
    value: z.enum(["positive", "negative", "both", "unknown"]),
    description: boundedText.nullable(),
  }),
  validFrom: instant.nullable(),
  validTo: instant.nullable(),
  schedule: z.array(scheduleSchema).optional(),
  sourceTokens: tokens,
  context: z.object({
    workingHours: z.array(scheduleSchema).optional(),
    restrictionsLiftable: z.boolean().nullable(),
    compliance: z.enum(["mandatory", "advisory", "unknown"]),
    operatorActionStatus: z.string().nullable(),
    validityStatus: z.string().nullable(),
    comments: z.array(z.object({ text: boundedText, language: z.string().nullable() })).optional(),
  }),
};

const factSchema = z.discriminatedUnion("kind", [
  z.object({
    ...factBase,
    kind: z.literal("dimension"),
    dimension: z.enum(["height", "width", "length", "gross_weight"]),
    meaning: z.enum(["maximum_permitted", "event_applies_when"]),
    value: z.number(),
    unit: z.enum(["m", "kg"]),
    operator: z.enum(["lt", "lte", "eq", "gte", "gt"]),
  }),
  z.object({
    ...factBase,
    kind: z.literal("vehicle_class"),
    meaning: z.literal("event_applies_when"),
    value: z.enum(["truck"]),
  }),
  z.object({
    ...factBase,
    kind: z.literal("vehicle_usage"),
    meaning: z.literal("event_applies_when"),
    value: z.enum(["emergency_services"]),
  }),
]);

const publishedRestrictionSchema = z
  .object({
    schemaVersion: z.literal(1),
    vehicleScope: z.enum(["specific", "unknown"]),
    completeness: z.enum(["complete", "partial"]),
    facts: z.array(factSchema),
    issues: z.array(issueSchema),
    source: sourceSchema,
    evaluatedAt: instant,
    sourceCheckedAt: instant.nullable(),
    freshUntil: instant.nullable(),
    nextTransitionAt: instant.nullable(),
    isStale: z.boolean(),
  })
  .superRefine((details, ctx) => {
    // An empty fact list is only meaningful as declared partial evidence with
    // at least one issue — never as "nothing here is restricted".
    if (
      details.facts.length === 0 &&
      (details.vehicleScope !== "unknown" ||
        details.completeness !== "partial" ||
        details.issues.length === 0)
    ) {
      ctx.addIssue({ code: "custom", message: "empty fact list without partial evidence" });
    }
    const ids = new Set<string>();
    for (const fact of details.facts) {
      if (ids.has(fact.id)) ctx.addIssue({ code: "custom", message: "duplicate fact id" });
      ids.add(fact.id);
      if (fact.kind !== "dimension") continue;
      const unitOk = fact.dimension === "gross_weight" ? fact.unit === "kg" : fact.unit === "m";
      const meaningOk = fact.meaning !== "maximum_permitted" || fact.operator === "lte";
      if (!Number.isFinite(fact.value) || fact.value <= 0 || !unitOk || !meaningOk) {
        ctx.addIssue({ code: "custom", message: "inconsistent dimension fact" });
      }
      if (fact.validFrom !== null && fact.validTo !== null) {
        if (Date.parse(fact.validFrom) >= Date.parse(fact.validTo)) {
          ctx.addIssue({ code: "custom", message: "non-increasing fact window" });
        }
      }
    }
  });

/**
 * Read the restriction fields from a feature's properties.
 *
 * Own-property presence is deliberate: a response that carries
 * `restrictionDetails: null` has made a claim we could not read, and must not
 * be treated as a record with no restriction.
 */
export function readRoadRestrictionDetails(
  properties: Record<string, unknown>,
): Pick<RoadConditionEvent, "restrictionDetails" | "restrictionDetailsUnsupported"> {
  if (Object.hasOwn(properties, "restrictionDetails")) {
    const parsed = publishedRestrictionSchema.safeParse(properties.restrictionDetails);
    return parsed.success
      ? { restrictionDetails: properties.restrictionDetails as PublishedRoadRestrictionDetailsV1 }
      : { restrictionDetailsUnsupported: true };
  }
  return properties.restrictionDetailsUnsupported === true
    ? { restrictionDetailsUnsupported: true }
    : {};
}

/** Does this event carry any restriction claim, valid or not? */
export function hasRoadRestrictionEvidence(
  event: Pick<RoadConditionEvent, "restrictionDetails" | "restrictionDetailsUnsupported">,
): boolean {
  return event.restrictionDetails !== undefined || event.restrictionDetailsUnsupported === true;
}
