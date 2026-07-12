/**
 * Wire types mirrored from @openconditions/contrib-core. Kept structurally
 * identical so the envelopes this client signs are accepted byte-for-byte by
 * the OpenConditions `verifyReport` / `verifySubClaim`. The signature only ever
 * covers RFC 8785 (JCS) canonical bytes, so TS types here are documentation and
 * signing-time guards — they never affect the signed bytes.
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

/** A subject reference: what the report is about. */
export interface SubjectRef {
  type: string;
  id: string;
  role?: string;
}

/**
 * The portable, signable content of a crowd report. This object — and nothing
 * else — is what the ES256 signature covers, as RFC 8785 (JCS) canonical bytes,
 * so it must stay strictly I-JSON: finite numbers, well-formed Unicode.
 */
export interface ReportClaim {
  domain: "roads" | "transit" | "places";
  /** Canonical taxonomy value, e.g. "hazard" or "road_closure". */
  type: string;
  /** WGS84 GeoJSON geometry of the reported condition. */
  geometry: GeoJsonGeometry;
  /** How precisely the geometry/extent is known (deliberate coarsening included). */
  fuzziness: Fuzziness;
  subject?: SubjectRef[];
  severityLevel?: 1 | 2 | 3 | 4 | 5;
  attributes?: Record<string, unknown>;
  /** ISO-8601 UTC instant with a zone designator. */
  reportedAt: string;
  /** Anti-replay/dedup token: 16..64 chars of [A-Za-z0-9_-]. */
  nonce: string;
}

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

export type SubClaimType = "confirm" | "negate" | "flag";

/**
 * The signable content of a sub-claim (a reaction to an existing report or
 * observation). Signed exactly like a {@link ReportClaim}: JCS bytes of this
 * body, WITHOUT the envelope fields.
 */
export interface SubClaimBody {
  /** "urn:openconditions:report:<base64url signature>" or an observation id. */
  subject: string;
  claimType: SubClaimType;
  /** Free text, only meaningful for "flag"; max 2000 chars. */
  reason?: string;
  geometry?: GeoJsonGeometry;
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
