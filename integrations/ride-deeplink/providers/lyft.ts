import type { DeepLinkConfig, DeepLinkProvider } from "../types.js";

/**
 * Lyft's universal link. `partner` is the client id from Lyft's developer
 * programme and is optional — without it the link still opens the app or
 * falls through to ride.lyft.com on the web. Parameter names follow Lyft's own
 * mobile SDKs: `pickup[latitude]` and `destination[latitude]`.
 *
 * Lyft's published developer terms restrict competitive applications and data
 * aggregation, so this provider sets `permitsComparison: false` where it is
 * registered.
 */
export const lyftProvider: DeepLinkProvider = {
  id: "lyft",
  name: "Lyft",
  homepage: "https://www.lyft.com/",
  brandColor: "#FF00BF",
  sourceId: "lyft",
  carriesCoordinates: true,
  build(request, config: DeepLinkConfig) {
    const params = new URLSearchParams();
    params.set("id", "lyft");
    const partner = config.lyftPartnerId?.trim();
    if (partner) params.set("partner", partner);
    params.set("pickup[latitude]", String(request.pickup[1]));
    params.set("pickup[longitude]", String(request.pickup[0]));
    if (request.pickupAddress) params.set("pickup[address]", request.pickupAddress);
    if (request.dropoff) {
      params.set("destination[latitude]", String(request.dropoff[1]));
      params.set("destination[longitude]", String(request.dropoff[0]));
      if (request.dropoffAddress) params.set("destination[address]", request.dropoffAddress);
    }
    const query = params.toString();
    return {
      webUrl: `https://lyft.com/ride?${query}`,
      androidUrl: `lyft://ridetype?${query}`,
      iosUrl: `lyft://ridetype?${query}`,
      carriesCoordinates: true,
    };
  },
};
