import type { LngLat } from "./geometry";

/**
 * What a ride provider can actually do. `deepLink` is the only capability every
 * provider must have — the rest are opt-in and gate the optional methods on
 * `RideProvider`.
 */
export type RideCapability = "deepLink" | "quote" | "booking" | "tracking";

/** One bookable service class. GOFS calls this a `service_brand`. */
export interface RideProduct {
  /** Provider-scoped id, e.g. "uberx" or "regular". */
  id: string;
  name: string;
  description?: string;
  seats?: number;
  wheelchairAccessible?: boolean;
  /** Feed-supplied brand colours, used for the product chip. */
  color?: string;
  textColor?: string;
}

export interface RideQuoteRequest {
  pickup: LngLat;
  /** Absent for pickup-only wait-time queries. */
  dropoff?: LngLat;
  pickupAddress?: string;
  dropoffAddress?: string;
  /** Wall-clock pickup time `YYYY-MM-DDTHH:mm` for a pre-booked ride. */
  pickupAt?: string;
  passengers?: number;
  productId?: string;
  lang?: string;
  /**
   * The driving route the caller already computed. Lets a provider with a
   * static distance/duration tariff price the trip without the orchestrator
   * re-routing server-side.
   */
  route?: { distanceMeters: number; durationSeconds: number };
}

export interface RideFare {
  amount?: number;
  /** Set instead of `amount` when the provider quotes a band. */
  min?: number;
  max?: number;
  currency: string;
  surgeMultiplier?: number;
  /** Provider-authored display string; render verbatim when present. */
  display?: string;
  /**
   * `quoted` came from the provider. `estimated` was computed locally from a
   * static tariff, and must be labelled as an estimate in the UI.
   */
  basis: "quoted" | "estimated";
}

export interface RideHandoff {
  /** Canonical URL to open. Always present. */
  webUrl: string;
  androidUrl?: string;
  iosUrl?: string;
  phoneNumber?: string;
  /** Whether the link actually carries pickup/dropoff coordinates. */
  carriesCoordinates: boolean;
}

export interface RideQuote {
  productId: string;
  product: RideProduct;
  pickupEtaSeconds?: number;
  travelSeconds?: number;
  fare?: RideFare;
  handoff?: RideHandoff;
  /** ISO-8601 instant after which this quote must not be displayed. */
  expiresAt: string;
  disclaimer?: string;
}

/** Generalised GOFS `booking_rules`. */
export interface RideBookingRules {
  /** 0 = real-time, 1 = same-day with notice, 2 = prior-day. */
  bookingType: 0 | 1 | 2;
  priorNoticeMinutesMin?: number;
  priorNoticeMinutesMax?: number;
  message?: string;
  infoUrl?: string;
}

export type RideUnavailableReason =
  | "outside-service-area"
  | "outside-operating-hours"
  | "no-products"
  | "provider-error";

export interface RideAvailability {
  available: boolean;
  /**
   * False when the provider cannot verify service at these coordinates — true
   * of every link-out provider. The UI says "opens the app" rather than
   * asserting the service is available.
   */
  coverageChecked: boolean;
  reason?: RideUnavailableReason;
  products: RideProduct[];
  bookingRules?: RideBookingRules;
}

/**
 * Booking types are declared so a future partner integration does not force a
 * breaking contract revision. No shipped provider implements them.
 */
export interface RideBookingRequest {
  productId: string;
  pickup: LngLat;
  dropoff: LngLat;
  pickupAddress?: string;
  dropoffAddress?: string;
  pickupAt?: string;
  passengers?: number;
  /** Opaque provider handle binding the booking to a prior quote. */
  quoteRef?: string;
  rider: { name?: string; phone?: string; email?: string };
}

export type RideBookingState =
  | "pending"
  | "accepted"
  | "arriving"
  | "in-progress"
  | "completed"
  | "cancelled"
  | "no-drivers";

export interface RideBooking {
  id: string;
  providerId: string;
  state: RideBookingState;
  product?: RideProduct;
  fare?: RideFare;
  pickupEtaSeconds?: number;
  vehicle?: { make?: string; model?: string; color?: string; licensePlate?: string };
  driver?: { displayName?: string; rating?: number };
  driverLocation?: LngLat;
  trackingUrl?: string;
  updatedAt: string;
}

/**
 * Attribution as it arrives over the wire. Structurally matches
 * mobility-core's `Attribution` field-for-field — kept inline here so
 * `@openmapx/core` never imports `@openmapx/mobility-core`, the same rule
 * `EvChargeStop.availability` follows in `routing.ts`.
 */
export interface RideAttribution {
  sourceId: string;
  name: string;
  url?: string;
  spdxLicense?: string;
  licenseUrl?: string;
  attributionText?: string;
  publisher?: { name: string; url?: string };
  retrievedAt?: string;
  notes?: string;
}

/** Serialisable provider descriptor returned by `GET /providers`. */
export interface RideProviderInfo {
  id: string;
  name: string;
  homepage: string;
  brandColor?: string;
  capabilities: Record<RideCapability, boolean>;
  permitsComparison: boolean;
  availability: RideAvailability;
  /**
   * Whether this provider's handoff link can actually carry the pickup and
   * destination. False for apps that publish no parameterised link format, so
   * the panel can say the trip will not carry over instead of letting the
   * destination vanish silently.
   */
  handoffCarriesCoordinates: boolean;
  isDefault: boolean;
}

/** Whether the operator has unlocked side-by-side quote comparison. */
export interface RideComparisonPolicy {
  allowed: boolean;
  /** Provider ids that may appear in a comparison list. */
  comparableProviderIds: string[];
}

export interface RideProvidersResponse {
  providers: RideProviderInfo[];
  defaultProvider: string | null;
  comparison: RideComparisonPolicy;
}

/**
 * Quotes are short-lived by contract. Anything that cannot be parsed is
 * treated as expired so a malformed provider response can never leave a stale
 * price on screen.
 */
export function isQuoteExpired(quote: RideQuote, now: Date): boolean {
  const expiry = Date.parse(quote.expiresAt);
  if (Number.isNaN(expiry)) return true;
  return now.getTime() >= expiry;
}
