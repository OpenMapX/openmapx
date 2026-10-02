/**
 * Wire types mirrored from the OpenConditions model claims
 * (@openconditions/model `SituationClaim`, `ObservationClaim`, `SubClaimBody`).
 * Kept structurally identical so the envelopes this client signs are accepted
 * byte-for-byte by the OpenConditions `verifyReport` / `verifySubClaim`. The
 * signature only ever covers RFC 8785 (JCS) canonical bytes, so TS types here
 * are documentation and signing-time guards — they never affect the signed
 * bytes. Which kinds, types, subtypes, effects and details a claim may carry is
 * decided by the receiving instance's registry, not here.
 */

/** A GeoJSON geometry position/coordinates tree (WGS84). */
export type GeoJsonPosition = number[];

/** WGS84 GeoJSON geometry of the reported condition. */
export interface GeoJsonGeometry {
  type:
    | "Point"
    | "MultiPoint"
    | "LineString"
    | "MultiLineString"
    | "Polygon"
    | "MultiPolygon"
    | "GeometryCollection";
  coordinates?: unknown;
  geometries?: GeoJsonGeometry[];
}

/** A WGS84 GeoJSON Point: where a reporter stood. */
export interface GeoJsonPoint {
  type: "Point";
  coordinates: [number, number] | [number, number, number];
}

/**
 * How precisely the geometry/extent is known (deliberate coarsening included).
 */
export type Fuzziness =
  | "exact"
  | "low_res"
  | "medium_res"
  | "end_unknown"
  | "start_unknown"
  | "extent_unknown";

/** Localised text; the first entry is the reporter's primary language. */
export type LocalizedText = { lang: string; text: string; machine?: true }[];

/** Which vehicles an effect applies to. */
export interface EffectApplicability {
  kind: "all" | "classes" | "unknown";
  include?: Record<string, unknown>[];
  except?: Record<string, unknown>[];
  raw?: string[];
}

/**
 * What a situation does to the network (a closure, a lane restriction). The
 * common members are fixed; each effect kind adds its own fields, which the
 * receiving registry validates.
 */
export interface Effect {
  /** Unique within the claim. */
  id: string;
  /** Effect kind code, e.g. "closure" or "lane_restriction". */
  kind: string;
  /** Major version of the effect kind. */
  v: number;
  applicability: EffectApplicability;
  compliance: "mandatory" | "advisory" | "unknown";
  normalization: "complete" | "partial" | "unsupported";
  [field: string]: unknown;
}

/**
 * "Something is happening here": a situation the reporter sees. This object —
 * and nothing else — is what the ES256 signature covers, as RFC 8785 (JCS)
 * canonical bytes, so it must stay strictly I-JSON: finite numbers,
 * well-formed Unicode.
 */
export interface SituationClaim {
  claimClass: "situation";
  /** Registered situation kind, e.g. "closure" or "incident". */
  kind: string;
  /** A type of that kind, e.g. "closure" or "accident". */
  type: string;
  subtype?: string;
  /** WGS84 GeoJSON geometry of the reported situation. */
  geometry: GeoJsonGeometry;
  /** How precisely the geometry/extent is known (deliberate coarsening included). */
  fuzziness: Fuzziness;
  severityLevel?: 1 | 2 | 3 | 4 | 5;
  effects?: Effect[];
  /** The kind's details, for a kind that requires some (a queue's level of service). */
  details?: Record<string, unknown>;
  text?: LocalizedText;
  /** ISO-8601 instant with a zone designator. */
  reportedAt: string;
  /** Anti-replay/dedup token: 16..64 chars of [A-Za-z0-9_-]. */
  nonce: string;
}

/** "This is the value now": a reading of a property of a feature or a place. */
export interface ObservationClaim {
  claimClass: "observation";
  subject: { featureId: string; componentKey?: string } | { location: Record<string, unknown> };
  property: string;
  qualifiers?: Record<string, unknown>;
  result: Record<string, unknown>;
  /** Where the reporter stood: checked against the subject on landing, never stored. */
  geometry: GeoJsonPoint;
  reportedAt: string;
  nonce: string;
}

/** The portable, signable content of a crowd report. */
export type ReportClaim = SituationClaim | ObservationClaim;

/**
 * A report claim plus its detached signature envelope. The envelope fields
 * (`alg`, `keyId`, `pubJwk`, `signature`) are NOT covered by the signature;
 * `keyId` is bound instead by the RFC 7638 thumbprint check at verification.
 */
export interface SignedReport {
  alg: "ES256";
  /** base64url RFC 7638 JWK SHA-256 thumbprint of the P-256 public key. */
  keyId: string;
  /** Present on first submission; the server caches it thereafter. */
  pubJwk?: JsonWebKey;
  claim: ReportClaim;
  /** base64url raw r||s (64 bytes) ES256 over `canonicalize(claim)` bytes. */
  signature: string;
}

/** The classes of record a sub-claim can react to. */
export type RecordClass = "feature" | "situation" | "observation" | "offer";

/** A reference to an existing record; only a feature has components. */
export interface RecordRef {
  class: RecordClass;
  id: string;
  componentKey?: string;
}

export type SubClaimType = "confirm" | "negate" | "flag";

/**
 * The signable content of a sub-claim (a reporter's reaction to an existing
 * record). Signed exactly like a {@link ReportClaim}: JCS bytes of this body,
 * WITHOUT the envelope fields.
 */
export interface SubClaimBody {
  subject: RecordRef;
  claimType: SubClaimType;
  /** Why a record is flagged; max 2000 chars. */
  reason?: string;
  /** Where the reporter stood. */
  geometry?: GeoJsonPoint;
  reportedAt: string;
  nonce: string;
}

export interface SignedSubClaim extends SubClaimBody {
  alg: "ES256";
  keyId: string;
  pubJwk?: JsonWebKey;
  /** Over `canonicalize(SubClaimBody)` — the body WITHOUT alg/keyId/pubJwk/signature. */
  signature: string;
}
