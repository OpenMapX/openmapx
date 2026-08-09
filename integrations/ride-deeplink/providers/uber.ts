import type { RideQuoteRequest } from "@openmapx/integration-framework";
import type { DeepLinkConfig, DeepLinkProvider } from "../types.js";

/**
 * Uber's two link formats take their locations differently, and mixing them up
 * silently drops the destination:
 *
 *   - the universal link (`https://m.uber.com/looking`) takes URL-encoded
 *     location JSON objects under `pickup` and `drop[0]`, and requires
 *     `client_id`;
 *   - the app scheme (`uber://riderequest`) takes flat bracketed scalars under
 *     `pickup[…]` and `dropoff[…]` — note `dropoff`, not `drop`.
 *
 * Uber's API terms forbid presenting Uber in an aggregated view alongside
 * competitors, which is why this provider sets `permitsComparison: false`
 * where it is registered.
 */
interface UberLocation {
  latitude: number;
  longitude: number;
  formatted_address?: string;
}

function toLocation(coords: [number, number], address: string | undefined): UberLocation {
  return { latitude: coords[1], longitude: coords[0], formatted_address: address };
}

/** App-scheme URL: flat bracketed scalars. Works with or without a client id. */
function buildAppUrl(request: RideQuoteRequest, clientId: string | undefined): string {
  const params = new URLSearchParams();
  if (clientId) params.set("client_id", clientId);
  params.set("action", "setPickup");
  params.set("pickup[latitude]", String(request.pickup[1]));
  params.set("pickup[longitude]", String(request.pickup[0]));
  if (request.pickupAddress) params.set("pickup[formatted_address]", request.pickupAddress);
  if (request.dropoff) {
    params.set("dropoff[latitude]", String(request.dropoff[1]));
    params.set("dropoff[longitude]", String(request.dropoff[0]));
    if (request.dropoffAddress) params.set("dropoff[formatted_address]", request.dropoffAddress);
  }
  return `uber://riderequest?${params.toString()}`;
}

/** Universal link: location JSON under `pickup` and `drop[0]`. Needs a client id. */
function buildUniversalUrl(request: RideQuoteRequest, clientId: string): string {
  const params = new URLSearchParams();
  params.set("client_id", clientId);
  params.set("pickup", JSON.stringify(toLocation(request.pickup, request.pickupAddress)));
  if (request.dropoff) {
    params.set("drop[0]", JSON.stringify(toLocation(request.dropoff, request.dropoffAddress)));
  }
  return `https://m.uber.com/looking?${params.toString()}`;
}

export const uberProvider: DeepLinkProvider = {
  id: "uber",
  name: "Uber",
  homepage: "https://www.uber.com/",
  brandColor: "#000000",
  sourceId: "uber",
  carriesCoordinates: true,
  build(request, config: DeepLinkConfig) {
    const clientId = config.uberClientId?.trim() || undefined;

    // Uber documents client_id as required on the universal link. Rather than
    // ship a web URL that may quietly ignore the trip, an unconfigured
    // deployment links to the plain site and says so — that is what
    // `carriesCoordinates: false` exists for. The app scheme still carries the
    // trip for anyone who has Uber installed.
    if (!clientId) {
      return {
        webUrl: "https://m.uber.com/",
        androidUrl: buildAppUrl(request, undefined),
        iosUrl: buildAppUrl(request, undefined),
        carriesCoordinates: false,
      };
    }

    return {
      webUrl: buildUniversalUrl(request, clientId),
      androidUrl: buildAppUrl(request, clientId),
      iosUrl: buildAppUrl(request, clientId),
      carriesCoordinates: true,
    };
  },
};
