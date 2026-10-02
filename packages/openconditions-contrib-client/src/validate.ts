import type {
  Effect,
  GeoJsonGeometry,
  ObservationClaim,
  ReportClaim,
  SituationClaim,
  SubClaimBody,
} from "./types";

/**
 * Structural and I-JSON validation for report claims and sub-claim bodies.
 * Every rule here is a signing-time hard rule (a TypeError) and mirrors the
 * structure of the OpenConditions model claims, so a claim this client will
 * sign has the shape the OpenConditions verifier expects. Whether a kind,
 * type, subtype, effect kind or details shape is registered is decided by the
 * receiving instance's registry, so those values are only checked as
 * well-formed here.
 */

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// ISO-8601 instant WITH a zone designator (Z or ±hh[:]mm); seconds and a
// fractional part are optional. Zone-less local times are rejected outright —
// a portable, federatable claim must pin its instant.
const ISO_ZONED_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

const BCP47 = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

const FUZZINESS_VALUES = new Set([
  "exact",
  "low_res",
  "medium_res",
  "end_unknown",
  "start_unknown",
  "extent_unknown",
]);

const GEOMETRY_TYPES = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

const SITUATION_KEYS = new Set([
  "claimClass",
  "kind",
  "type",
  "subtype",
  "geometry",
  "fuzziness",
  "severityLevel",
  "effects",
  "details",
  "text",
  "reportedAt",
  "nonce",
]);

const OBSERVATION_KEYS = new Set([
  "claimClass",
  "subject",
  "property",
  "qualifiers",
  "result",
  "geometry",
  "reportedAt",
  "nonce",
]);

const SUB_CLAIM_KEYS = new Set([
  "subject",
  "claimType",
  "reason",
  "geometry",
  "reportedAt",
  "nonce",
]);

const RECORD_REF_KEYS = new Set(["class", "id", "componentKey"]);

const RECORD_CLASSES = new Set(["feature", "situation", "observation", "offer"]);

const APPLICABILITY_KINDS = new Set(["all", "classes", "unknown"]);

const COMPLIANCE_VALUES = new Set(["mandatory", "advisory", "unknown"]);

const NORMALIZATION_VALUES = new Set(["complete", "partial", "unsupported"]);

const SUB_CLAIM_TYPES = new Set(["confirm", "negate", "flag"]);

/** Signature-envelope fields a signable body must never carry itself. */
export const ENVELOPE_FIELDS = ["alg", "keyId", "pubJwk", "signature"] as const;

const MAX_REASON_CHARS = 2000;

/** True when the string contains an unpaired UTF-16 surrogate (not I-JSON). */
function hasLoneSurrogate(text: string): boolean {
  for (const char of text) {
    const codePoint = char.codePointAt(0) as number;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true;
  }
  return false;
}

/** Maximum container nesting depth a claim tree may have. */
const MAX_TREE_DEPTH = 64;

/**
 * Walk a claim tree and enforce I-JSON: finite numbers and well-formed Unicode
 * everywhere (keys included). Values JCS would silently drop or coerce are
 * rejected so the signed bytes never diverge from the author's intent; an
 * `undefined` OBJECT member is allowed because JCS deterministically omits it.
 * Nesting is capped at {@link MAX_TREE_DEPTH} so the walk itself can never
 * overflow the stack.
 */
function assertIJsonTree(value: unknown, path: string, depth = 0): void {
  if (depth > MAX_TREE_DEPTH) {
    throw new TypeError(`nesting depth at ${path} exceeds ${MAX_TREE_DEPTH} levels`);
  }
  switch (typeof value) {
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`non-finite number at ${path}`);
      }
      return;
    case "string":
      if (hasLoneSurrogate(value)) {
        throw new TypeError(`string with a lone surrogate at ${path}`);
      }
      return;
    case "boolean":
    case "undefined":
      return;
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError(`${typeof value} value at ${path} is not JSON-serializable`);
  }
  if (value === null) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const element = value[i] as unknown;
      if (element === undefined || typeof element === "symbol") {
        throw new TypeError(
          `array element at ${path}[${i}] is not JSON-serializable (JCS would coerce it to null)`,
        );
      }
      assertIJsonTree(element, `${path}[${i}]`, depth + 1);
    }
    return;
  }
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (hasLoneSurrogate(key)) {
      throw new TypeError(`object key with a lone surrogate at ${path}`);
    }
    assertIJsonTree(member, `${path}.${key}`, depth + 1);
  }
}

function assertNonce(nonce: unknown, path: string): void {
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) {
    throw new TypeError(`${path}: nonce must be 16..64 characters of [A-Za-z0-9_-]`);
  }
}

function assertReportedAt(reportedAt: unknown, path: string): void {
  if (
    typeof reportedAt !== "string" ||
    !ISO_ZONED_INSTANT.test(reportedAt) ||
    !Number.isFinite(Date.parse(reportedAt))
  ) {
    throw new TypeError(
      `${path}: reportedAt must be an ISO-8601 instant with a zone designator (e.g. "2026-07-11T12:00:00Z")`,
    );
  }
  // V8 rolls impossible days-of-month within 01..31 ("2026-02-30" parses as
  // March 2), so re-derive the calendar date from the string's own Y-M-D at
  // UTC midnight and require it to survive the round trip unchanged.
  const year = Number(reportedAt.slice(0, 4));
  const month = Number(reportedAt.slice(5, 7));
  const day = Number(reportedAt.slice(8, 10));
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new TypeError(`${path}: reportedAt has an impossible calendar date: ${reportedAt}`);
  }
}

function assertGeometry(geometry: unknown, path: string): void {
  if (
    geometry === null ||
    typeof geometry !== "object" ||
    Array.isArray(geometry) ||
    !GEOMETRY_TYPES.has((geometry as GeoJsonGeometry).type)
  ) {
    throw new TypeError(`${path}: geometry must be a GeoJSON geometry object`);
  }
}

function assertPoint(geometry: unknown, path: string): void {
  assertPlainObject(geometry, `${path}.geometry`);
  const { type, coordinates } = geometry as { type?: unknown; coordinates?: unknown };
  if (
    type !== "Point" ||
    !Array.isArray(coordinates) ||
    (coordinates.length !== 2 && coordinates.length !== 3) ||
    !coordinates.every((value) => typeof value === "number")
  ) {
    throw new TypeError(`${path}: geometry must be a GeoJSON Point`);
  }
  assertOnlyKeys(geometry as object, new Set(["type", "coordinates"]), `${path}.geometry`);
}

function assertPlainObject(value: unknown, path: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
}

function assertOnlyKeys(value: object, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${path} must not carry the field "${key}"`);
    }
  }
}

function assertNonEmptyString(value: unknown, path: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function assertEffects(effects: unknown): void {
  if (!Array.isArray(effects) || effects.length === 0) {
    throw new TypeError("claim.effects must be a non-empty array of effects");
  }
  const ids = new Set<string>();
  for (const [index, effect] of (effects as unknown[]).entries()) {
    const path = `claim.effects[${index}]`;
    assertPlainObject(effect, path);
    const { id, kind, v, applicability, compliance, normalization } = effect as Effect;
    assertNonEmptyString(id, `${path}.id`);
    if (ids.has(id)) {
      throw new TypeError(`claim.effects: effect id "${id}" repeats`);
    }
    ids.add(id);
    assertNonEmptyString(kind, `${path}.kind`);
    if (!Number.isInteger(v) || v < 1) {
      throw new TypeError(`${path}.v must be a positive integer major version`);
    }
    assertPlainObject(applicability, `${path}.applicability`);
    if (!APPLICABILITY_KINDS.has(applicability.kind)) {
      throw new TypeError(
        `${path}.applicability.kind must be one of "all" | "classes" | "unknown"`,
      );
    }
    if (typeof compliance !== "string" || !COMPLIANCE_VALUES.has(compliance)) {
      throw new TypeError(`${path}.compliance must be one of "mandatory" | "advisory" | "unknown"`);
    }
    if (typeof normalization !== "string" || !NORMALIZATION_VALUES.has(normalization)) {
      throw new TypeError(
        `${path}.normalization must be one of "complete" | "partial" | "unsupported"`,
      );
    }
  }
}

function assertText(text: unknown): void {
  if (!Array.isArray(text) || text.length === 0) {
    throw new TypeError("claim.text must be a non-empty array of localized texts");
  }
  for (const [index, entry] of (text as unknown[]).entries()) {
    const path = `claim.text[${index}]`;
    assertPlainObject(entry, path);
    assertOnlyKeys(entry as object, new Set(["lang", "text", "machine"]), path);
    const {
      lang,
      text: value,
      machine,
    } = entry as { lang?: unknown; text?: unknown; machine?: unknown };
    if (typeof lang !== "string" || !BCP47.test(lang)) {
      throw new TypeError(`${path}.lang must be a BCP 47 language tag`);
    }
    assertNonEmptyString(value, `${path}.text`);
    if (machine !== undefined && machine !== true) {
      throw new TypeError(`${path}.machine must be true when present`);
    }
  }
}

function validateSituationClaim(claim: SituationClaim): void {
  assertOnlyKeys(claim, SITUATION_KEYS, "claim");
  assertNonEmptyString(claim.kind, "claim.kind");
  assertNonEmptyString(claim.type, "claim.type");
  if (claim.subtype !== undefined) {
    assertNonEmptyString(claim.subtype, "claim.subtype");
  }
  assertGeometry(claim.geometry, "claim");
  if (typeof claim.fuzziness !== "string" || !FUZZINESS_VALUES.has(claim.fuzziness)) {
    throw new TypeError("claim.fuzziness must be a canonical Fuzziness value");
  }
  if (
    claim.severityLevel !== undefined &&
    (!Number.isInteger(claim.severityLevel) || claim.severityLevel < 1 || claim.severityLevel > 5)
  ) {
    throw new TypeError("claim.severityLevel must be an integer 1..5");
  }
  if (claim.effects !== undefined) {
    assertEffects(claim.effects);
  }
  if (claim.details !== undefined) {
    assertPlainObject(claim.details, "claim.details");
  }
  if (claim.text !== undefined) {
    assertText(claim.text);
  }
}

function validateObservationClaim(claim: ObservationClaim): void {
  assertOnlyKeys(claim, OBSERVATION_KEYS, "claim");
  assertPlainObject(claim.subject, "claim.subject");
  if ("featureId" in claim.subject) {
    assertOnlyKeys(claim.subject, new Set(["featureId", "componentKey"]), "claim.subject");
    assertNonEmptyString(claim.subject.featureId, "claim.subject.featureId");
    if (claim.subject.componentKey !== undefined) {
      assertNonEmptyString(claim.subject.componentKey, "claim.subject.componentKey");
    }
  } else {
    assertOnlyKeys(claim.subject, new Set(["location"]), "claim.subject");
    assertPlainObject((claim.subject as { location?: unknown }).location, "claim.subject.location");
  }
  assertNonEmptyString(claim.property, "claim.property");
  if (claim.qualifiers !== undefined) {
    assertPlainObject(claim.qualifiers, "claim.qualifiers");
  }
  assertPlainObject(claim.result, "claim.result");
  assertPoint(claim.geometry, "claim");
}

/**
 * Validate a {@link ReportClaim} against the wire contract's hard rules.
 *
 * @throws TypeError naming the first violated rule.
 */
export function validateReportClaim(claim: ReportClaim): void {
  assertPlainObject(claim, "claim");
  switch (claim.claimClass) {
    case "situation":
      validateSituationClaim(claim);
      break;
    case "observation":
      validateObservationClaim(claim);
      break;
    default:
      throw new TypeError(`claim.claimClass must be one of "situation" | "observation"`);
  }
  assertReportedAt(claim.reportedAt, "claim");
  assertNonce(claim.nonce, "claim");
  assertIJsonTree(claim, "claim");
}

/**
 * Validate a {@link SubClaimBody} against the wire contract's hard rules. The
 * body must not smuggle envelope fields: they are added by signSubClaim and
 * stripped before verification, so a body carrying them would sign bytes the
 * verifier never reconstructs.
 *
 * @throws TypeError naming the first violated rule.
 */
export function validateSubClaimBody(body: SubClaimBody): void {
  assertPlainObject(body, "subClaim");
  for (const field of ENVELOPE_FIELDS) {
    if (field in body) {
      throw new TypeError(`subClaim body must not carry the envelope field "${field}"`);
    }
  }
  assertOnlyKeys(body, SUB_CLAIM_KEYS, "subClaim");
  assertPlainObject(body.subject, "subClaim.subject");
  assertOnlyKeys(body.subject, RECORD_REF_KEYS, "subClaim.subject");
  if (!RECORD_CLASSES.has(body.subject.class)) {
    throw new TypeError(
      `subClaim.subject.class must be one of "feature" | "situation" | "observation" | "offer"`,
    );
  }
  assertNonEmptyString(body.subject.id, "subClaim.subject.id");
  if (body.subject.componentKey !== undefined) {
    assertNonEmptyString(body.subject.componentKey, "subClaim.subject.componentKey");
    if (body.subject.class !== "feature") {
      throw new TypeError("subClaim.subject.componentKey is only allowed on a feature");
    }
  }
  if (typeof body.claimType !== "string" || !SUB_CLAIM_TYPES.has(body.claimType)) {
    throw new TypeError(`subClaim.claimType must be one of "confirm" | "negate" | "flag"`);
  }
  if (body.reason !== undefined) {
    if (
      typeof body.reason !== "string" ||
      body.reason.length === 0 ||
      body.reason.length > MAX_REASON_CHARS
    ) {
      throw new TypeError(
        `subClaim.reason must be a non-empty string of at most ${MAX_REASON_CHARS} characters`,
      );
    }
  }
  if (body.geometry !== undefined) {
    assertPoint(body.geometry, "subClaim");
  }
  assertReportedAt(body.reportedAt, "subClaim");
  assertNonce(body.nonce, "subClaim");
  assertIJsonTree(body, "subClaim");
}
