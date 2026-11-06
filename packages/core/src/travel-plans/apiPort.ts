import {
  type ContributingRecord,
  captureResultContributors,
} from "@openmapx/mobility-core/contributors";
import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { Departure, TransitStop } from "@openmapx/mobility-core/transit";
import { type ApiClient, apiClient, isApiClientError } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { fetchReferencedTransitPlan, fetchTransitPlan, fetchVehicleJourney } from "../api/transit";
import { haversineDistance } from "../utils/coordinates";
import { type TravelPlanPort, TravelPlanResolutionError } from "./resolve";
import { travelStationKey } from "./types";

function data<T>(envelope: MobilityEnvelope<T>): T {
  if (envelope.freshness.isPartial || envelope.freshness.isStale)
    throw new TravelPlanResolutionError("unavailable");
  return envelope.data;
}
function records<T extends ContributingRecord>(envelope: MobilityEnvelope<T[]>): T[] {
  return data(envelope).map((record) => ({
    ...record,
    contributors: captureResultContributors(record, envelope.attributions),
  }));
}
/** All network traffic remains behind the configured OpenMapX API client. */
export function createTravelPlanPort(client: ApiClient = apiClient): TravelPlanPort {
  const options = (signal: AbortSignal) => ({ signal, timeoutMs: 15000 });
  return {
    async searchStops(name, signal) {
      const envelope = await client.get<MobilityEnvelope<TransitStop[]>>(
        API_ENDPOINTS.transitStopSearch,
        { q: name, limit: "20" },
        options(signal),
      );
      // A partial global name search is discovery, never proof of a train. Corroborate
      // its geographic anchor with the selected baseline's nearby rail-stop surface.
      const anchors = envelope.data.filter(
        // MOTIS name search can omit modes. It is only an anchor; nearby rail
        // stops and the dated board/journey still supply the identity evidence.
        (s) =>
          (!s.modes.length || s.modes.includes("rail")) &&
          travelStationKey(s.name) === travelStationKey(name),
      );
      if (!anchors.length) return [];
      const first = anchors[0];
      if (anchors.some((s) => haversineDistance([first.lng, first.lat], [s.lng, s.lat]) > 1500))
        throw new TravelPlanResolutionError("ambiguous");
      const nearby = await client.get<MobilityEnvelope<TransitStop[]>>(
        API_ENDPOINTS.transitStopsNearby,
        { lat: String(first.lat), lng: String(first.lng), radius: "1500", modes: "rail" },
        options(signal),
      );
      return [
        ...anchors.map((record) => ({
          ...record,
          contributors: captureResultContributors(record, envelope.attributions),
        })),
        ...records(nearby).filter(
          (s) => haversineDistance([first.lng, first.lat], [s.lng, s.lat]) <= 1500,
        ),
      ].filter((s) => travelStationKey(s.name) === travelStationKey(name));
    },
    async departures(stopId, time, signal) {
      try {
        return records(
          await client.get<MobilityEnvelope<Departure[]>>(
            API_ENDPOINTS.transitDepartures.replace(":id", encodeURIComponent(stopId)),
            { time, minutes: "60" },
            options(signal),
          ),
        );
      } catch (error) {
        if (isApiClientError(error) && error.status === 501) return null;
        throw error;
      }
    },
    async journey(tripId, signal) {
      const envelope = await fetchVehicleJourney({ tripId }, client, options(signal));
      const journey = data(envelope);
      return {
        ...journey,
        contributors: captureResultContributors(journey, envelope.attributions),
      };
    },
    async plan(params, signal) {
      try {
        const envelope = await fetchTransitPlan(params, client, options(signal));
        data(envelope);
        return envelope;
      } catch (error) {
        if (isApiClientError(error) && error.status === 503) return null;
        throw error;
      }
    },
    async resolveTrip(params, signal) {
      const envelope = await fetchReferencedTransitPlan(params, client, options(signal));
      data(envelope);
      return envelope;
    },
  };
}
