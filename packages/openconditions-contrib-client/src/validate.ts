import type { GeoJsonGeometry, ReportClaim, SubClaimBody } from "./types.js";

/**
 * Structural and I-JSON validation for report claims and sub-claim bodies.
 * Every rule here is a signing-time hard rule (a TypeError) and mirrors
 * @openconditions/contrib-core's verification-time rules, so a claim this
 * client will sign is a claim the OpenConditions verifier will accept.
 */

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// ISO-8601 instant WITH a zone designator (Z or ±hh[:]mm); seconds and a
// fractional part are optional. Zone-less local times are rejected outright —
// a portable, federatable claim must pin its instant.
const ISO_ZONED_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

const DOMAINS = new Set(["roads", "transit", "places"]);

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

function assertPlainObject(value: unknown, path: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
}

/**
 * Validate a {@link ReportClaim} against the wire contract's hard rules.
 *
 * @throws TypeError naming the first violated rule.
 */
export function validateReportClaim(claim: ReportClaim): void {
  assertPlainObject(claim, "claim");
  if (!DOMAINS.has(claim.domain)) {
    throw new TypeError(`claim.domain must be one of "roads" | "transit" | "places"`);
  }
  if (typeof claim.type !== "string" || claim.type.length === 0) {
    throw new TypeError("claim.type must be a non-empty canonical taxonomy value");
  }
  assertGeometry(claim.geometry, "claim");
  if (typeof claim.fuzziness !== "string" || !FUZZINESS_VALUES.has(claim.fuzziness)) {
    throw new TypeError("claim.fuzziness must be a canonical Fuzziness value");
  }
  if (claim.subject !== undefined) {
    if (!Array.isArray(claim.subject)) {
      throw new TypeError("claim.subject must be an array of subject refs");
    }
    for (const [index, ref] of claim.subject.entries()) {
      assertPlainObject(ref, `claim.subject[${index}]`);
      if (typeof ref.type !== "string" || !ref.type || typeof ref.id !== "string" || !ref.id) {
        throw new TypeError(`claim.subject[${index}] must carry non-empty string type and id`);
      }
    }
  }
  if (
    claim.severityLevel !== undefined &&
    (!Number.isInteger(claim.severityLevel) || claim.severityLevel < 1 || claim.severityLevel > 5)
  ) {
    throw new TypeError("claim.severityLevel must be an integer 1..5");
  }
  if (claim.attributes !== undefined) {
    assertPlainObject(claim.attributes, "claim.attributes");
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
  if (typeof body.subject !== "string" || body.subject.length === 0) {
    throw new TypeError("subClaim.subject must be a non-empty string");
  }
  if (typeof body.claimType !== "string" || !SUB_CLAIM_TYPES.has(body.claimType)) {
    throw new TypeError(`subClaim.claimType must be one of "confirm" | "negate" | "flag"`);
  }
  if (body.reason !== undefined) {
    if (typeof body.reason !== "string" || body.reason.length > MAX_REASON_CHARS) {
      throw new TypeError(
        `subClaim.reason must be a string of at most ${MAX_REASON_CHARS} characters`,
      );
    }
  }
  if (body.geometry !== undefined) {
    assertGeometry(body.geometry, "subClaim");
  }
  assertReportedAt(body.reportedAt, "subClaim");
  assertNonce(body.nonce, "subClaim");
  assertIJsonTree(body, "subClaim");
}
