export interface ReviewSubject {
  /** Latitude, WGS84. */
  lat: number;
  /** Longitude, WGS84. */
  lng: number;
  /** Canonical place name — used in the Mangrove geo-URI query string. */
  name: string;
  /** Optional stable OSM reference (e.g. "node/12345") — passed to providers as metadata. */
  osmId?: string;
}

export interface ReviewAggregate {
  /** Total number of reviews (including opinion-only and edits). */
  count: number;
  /** How many reviews include opinion text. */
  opinionCount: number;
  /** Reviews with rating >= 50 (recommend). */
  positiveCount: number;
  /** Reviews confirmed by other users (positive maresi replies). */
  confirmedCount: number;
  /** Aggregate quality score, 0..100 (Mangrove's normalized rating). */
  quality: number;
  /** Convenience: quality / 20 (0..5). */
  stars: number;
}

export interface ReviewAuthor {
  /** Stable public-key identifier (PEM of the ECDSA P-256 key). */
  kid: string;
  /** Optional self-reported nickname. */
  nickname?: string;
}

export interface ReviewImage {
  src: string;
  label?: string;
}

export type ReviewAction = "edit" | "delete" | "report_abuse" | "equivalence";

export interface ReviewMetadata {
  /** OSM element reference (e.g. "way/1234" or "node/56/7"). */
  osmId?: string;
  /** URL/ID of the client app that produced the review. */
  clientId?: string;
  /** One of "business" | "family" | "couple" | "friends" | "solo". */
  experienceContext?: string;
  /** Affiliation disclosure. */
  isAffiliated?: boolean;
  /** SPDX license for the review content. */
  license?: "CC-BY-4.0" | "CC-BY-SA-4.0";
}

export interface Review {
  /** Unique id = the review's JWT signature segment. */
  id: string;
  subject: ReviewSubject;
  /** Raw rating as stored (0..100). UI should prefer `stars`. */
  rating?: number;
  /** Rating rescaled to 0..5. */
  stars?: number;
  /** Free-form text (max 1000 chars). */
  opinion?: string;
  images?: ReviewImage[];
  author: ReviewAuthor;
  /** ISO timestamp derived from payload.iat. */
  createdAt: string;
  /** Non-null when this review is an edit/delete/report of another. */
  action?: ReviewAction;
  /** If `action` targets another review, that review's id (= signature). */
  targetId?: string;
  metadata?: ReviewMetadata;
}

/** A pluggable review source. */
export interface ReviewProvider {
  readonly id: string;
  readonly name: string;
  getReviews(subject: ReviewSubject): Promise<Review[]>;
  getAggregate(subject: ReviewSubject): Promise<ReviewAggregate>;
  /** Forwards a pre-signed JWT to the upstream review store. */
  submit?(signedJwt: string): Promise<{ id: string }>;
  /** Uploads an image and returns an absolute URL referencing it. */
  uploadImage?(file: Blob, filename: string): Promise<{ src: string }>;
}
