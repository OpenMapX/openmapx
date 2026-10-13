/** Available address parts, without interpreting missing numbers as invalid. */
export interface PlaceAddressComponents {
  house_number?: string;
  house?: string;
  road?: string;
  place?: string;
  full?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
}

/** Evidence belongs to one address candidate; never blend conflicting candidates. */
export interface AddressEvidence {
  components: PlaceAddressComponents;
  source: string;
  method: "osm-tags" | "provider-address" | "provider-label" | "reverse";
  /** Canonical supplying record ID. Nominatim hierarchy is not explicit addr:* evidence. */
  recordId?: string;
}

/** A direct root reference, distinct from identities borrowed during conflation. */
export interface DirectOsmReference {
  source: "geocoding-maptiler";
  recordId: string;
  osmRef: string;
}
