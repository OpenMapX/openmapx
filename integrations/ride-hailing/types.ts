import type {
  RideAttribution,
  RideComparisonPolicy,
  RideProvider,
  RideProviderInfo,
  RideQuote,
} from "@openmapx/integration-framework";

export interface ResolvedRideProvider {
  provider: RideProvider;
  integrationId: string;
}

export interface RideProviderListing {
  providers: RideProviderInfo[];
  defaultProvider: string | null;
  comparison: RideComparisonPolicy;
}

export interface RideQuoteResult {
  providerId: string;
  quotes: RideQuote[];
  /**
   * `RideAttribution` rather than mobility-core's `Attribution`: the two are
   * structurally identical, and using the core type keeps the wire shape the
   * client hook consumes identical to the one the orchestrator emits.
   */
  attributions: RideAttribution[];
}
