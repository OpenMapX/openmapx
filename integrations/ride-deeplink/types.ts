import type { RideHandoff, RideQuoteRequest } from "@openmapx/integration-framework";

/** Operator-supplied affiliate identifiers. Applied server-side only. */
export interface DeepLinkConfig {
  uberClientId?: string;
  lyftPartnerId?: string;
}

/**
 * A pure URL builder for one ride-hailing app. No network calls, no
 * credentials required — the affiliate ids are optional and only change how
 * the referral is attributed.
 */
export interface DeepLinkProvider {
  id: string;
  name: string;
  homepage: string;
  brandColor?: string;
  /** Matches a `dataSources[].sourceId` in the integration manifest. */
  sourceId: string;
  /**
   * Whether this provider's link format can encode the pickup and dropoff.
   * When false the panel tells the user the destination will not carry over.
   */
  carriesCoordinates: boolean;
  build(request: RideQuoteRequest, config: DeepLinkConfig): RideHandoff;
}
