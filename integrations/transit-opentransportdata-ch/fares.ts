import type { FareProduct, TripFare } from "@openmapx/mobility-core/transit";
import {
  buildOjpFareRequestXml,
  type OjpFareProduct,
  type OjpFareResult,
  type OjpTripResponse,
  type OjpTripResult,
  parseOjpFareResponse,
  type XmlObject,
} from "@openmapx/mobility-formats";
import { type SwissProviderRuntime, swissContributors } from "./common.js";

export interface SwissFareAssignment {
  effectiveFareLegIndex: number;
  fareTransferIndex: number;
}

interface SwissMappedFareBundle {
  fare: TripFare;
  legAssignments: Map<string, SwissFareAssignment>;
}

function mapOjpFareProduct(
  runtime: SwissProviderRuntime,
  product: OjpFareProduct,
): FareProduct | null {
  if (product.amount == null || !product.currency) return null;
  return {
    contributors: swissContributors(runtime, "ojp-fare"),
    amount: product.amount,
    authorityName: product.authorityName,
    authorityRef: product.authorityRef,
    currency: product.currency,
    id: product.id,
    infoUrls: product.infoUrls,
    name: product.name,
    netAmount: product.netAmount,
    saleUrls: product.saleUrls,
    travelClass: product.travelClass,
    vatRate: product.vatRate,
  };
}

export function mapOjpFareBundle(
  runtime: SwissProviderRuntime,
  fareResult: OjpFareResult | undefined,
  trip: OjpTripResult,
): SwissMappedFareBundle | undefined {
  if (!fareResult?.trips.length) return undefined;

  const tripLegIds = trip.legs.map((leg) => leg.id);
  const legAssignments = new Map<string, SwissFareAssignment>();
  const results: NonNullable<TripFare["results"]> = [];
  for (const [effectiveFareLegIndex, fareTrip] of fareResult.trips.entries()) {
    const products = fareTrip.products
      .map(mapOjpFareProduct.bind(null, runtime))
      .filter((value): value is FareProduct => Boolean(value));
    if (!products.length) continue;

    const startIndex = fareTrip.fromLegId ? tripLegIds.indexOf(fareTrip.fromLegId) : -1;
    const endIndex = fareTrip.toLegId ? tripLegIds.indexOf(fareTrip.toLegId) : startIndex;
    if (startIndex >= 0) {
      const finalIndex = endIndex >= startIndex ? endIndex : startIndex;
      for (let legIndex = startIndex; legIndex <= finalIndex; legIndex += 1) {
        const legId = tripLegIds[legIndex];
        if (!legId) continue;
        legAssignments.set(legId, {
          effectiveFareLegIndex,
          fareTransferIndex: 0,
        });
      }
    }

    results.push({
      fromLegId: fareTrip.fromLegId,
      products,
      toLegId: fareTrip.toLegId,
    });
  }
  if (!results.length) return undefined;

  const transferProducts = results.flatMap((result) => result.products);
  return {
    fare: {
      contributors: swissContributors(runtime, "ojp-fare"),
      results,
      source: "ojpfare",
      transfers: [
        {
          legProducts: results.map((result) => [result.products]),
          rule: fareResult.id,
          transferProducts: transferProducts.length ? transferProducts : undefined,
        },
      ],
    },
    legAssignments,
  };
}

export async function requestTripFares(
  runtime: SwissProviderRuntime,
  response: OjpTripResponse,
  rawTrips: XmlObject[],
): Promise<Array<OjpFareResult | undefined>> {
  const config = runtime.client.config;
  return Promise.all(
    response.trips.map(async (trip, index) => {
      const rawTrip = rawTrips[index];
      if (!rawTrip || !trip.legs.some((leg) => leg.kind === "timed")) return undefined;

      try {
        const xml = buildOjpFareRequestXml({
          fareAuthorityFilter: "ch:1:NOVA",
          language: config.requestLanguage,
          requestorRef: config.requestorRef,
          trips: [rawTrip],
        });
        return parseOjpFareResponse(
          await runtime.client.requestSwissOjpFare(xml, {
            cacheNamespace: "trip-fare",
            cacheTtlSeconds: 300,
          }),
        ).fares[0];
      } catch (error) {
        config.log?.warn?.("Swiss OJP fare request failed", trip.id ?? index, error);
        return undefined;
      }
    }),
  );
}
