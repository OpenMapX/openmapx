import type {
  RideAvailability,
  RideBooking,
  RideBookingRequest,
  RideCapability,
  RideHandoff,
  RideQuote,
  RideQuoteRequest,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { MobilityResult } from "@openmapx/mobility-core/result";

export type {
  RideAttribution,
  RideAvailability,
  RideBooking,
  RideBookingRequest,
  RideBookingRules,
  RideBookingState,
  RideCapability,
  RideComparisonPolicy,
  RideFare,
  RideHandoff,
  RideProduct,
  RideProviderInfo,
  RideProvidersResponse,
  RideQuote,
  RideQuoteRequest,
  RideUnavailableReason,
} from "@openmapx/core";

export interface RideProviderMeta {
  name: string;
  homepage: string;
  /** The manifest `dataSources[].sourceId` this provider attributes to. */
  sourceId: string;
  brandColor?: string;
}

/**
 * A ride-hailing provider. Deliberately NOT a `RoutingProvider`: it returns
 * products, ETAs, fares and booking handoffs, never route geometry. Route
 * geometry for the `ride` travel mode comes from the normal driving router.
 */
export interface RideProvider {
  readonly id: string;
  readonly meta: RideProviderMeta;
  readonly capabilities: Record<RideCapability, boolean>;
  /**
   * Whether this provider's terms permit rendering it in a list beside
   * competitors. Encodes the provider's terms, not operator preference, so it
   * is never overridable by configuration.
   */
  readonly permitsComparison: boolean;
  readonly coverage?: { countries?: string[]; bbox?: [number, number, number, number] };
  readonly attribution: Attribution[];
  /** Seconds a quote from this provider stays displayable. Default 60. */
  readonly quoteTtlSeconds?: number;

  getAvailability(request: RideQuoteRequest): Promise<MobilityResult<RideAvailability>>;
  /** The one required capability. Sync-or-async so pure builders stay trivial. */
  createHandoff(request: RideQuoteRequest): Promise<RideHandoff> | RideHandoff;

  getQuotes?(request: RideQuoteRequest): Promise<MobilityResult<RideQuote[]>>;
  book?(request: RideBookingRequest): Promise<RideBooking>;
  getBooking?(bookingId: string): Promise<RideBooking>;
  cancelBooking?(bookingId: string): Promise<RideBooking>;
}
