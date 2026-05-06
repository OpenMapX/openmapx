/** Wire shapes for the Mangrove.reviews HTTP API. */

export interface MangroveWireReview {
  signature: string;
  jwt: string;
  kid: string;
  payload: MangroveWirePayload;
  scheme?: string;
  /** Present on latest edit/delete records returned for the original place subject. */
  original_sub?: string;
}

export interface MangroveWirePayload {
  sub: string;
  iat: number;
  rating?: number;
  opinion?: string;
  images?: { src: string; label?: string }[];
  action?: "edit" | "delete" | "report_abuse" | "equivalence";
  metadata?: {
    client_id?: string;
    nickname?: string;
    preferred_username?: string;
    experience_context?: string;
    is_personal_experience?: boolean;
    is_affiliated?: boolean;
    is_generated?: boolean;
    data_source?: string;
    original_url?: string;
    osm_id?: string;
    reviewer_index?: number;
    license?: string;
  };
}

export interface MangroveWireSubject {
  sub: string;
  count: number;
  opinion_count: number;
  positive_count: number;
  confirmed_count: number;
  /** Null when count is too small for a meaningful weighted score. */
  quality: number | null;
}

export interface MangroveWireReviewsResponse {
  reviews: MangroveWireReview[];
  issuers?: Record<string, { count: number; neutrality?: number; credibility?: number }>;
  maresi_subjects?: Record<string, MangroveWireSubject>;
}
