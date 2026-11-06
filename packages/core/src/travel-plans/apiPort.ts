import {
  type ContributingRecord,
  captureResultContributors,
} from "@openmapx/mobility-core/contributors";
import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { Departure, GeoJSONLineString, TransitStop } from "@openmapx/mobility-core/transit";
import { type ApiClient, apiClient, isApiClientError } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { fetchVehicleJourney } from "../api/transit";
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
        (s) => s.modes.includes("rail") && travelStationKey(s.name) === travelStationKey(name),
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
        ...records(nearby),
      ].filter((s) => travelStationKey(s.name) === travelStationKey(name));
    },
    async departures(stopId, time, signal) {
      try {
        return records(
          await client.get<MobilityEnvelope<Departure[]>>(
            API_ENDPOINTS.transitDepartures.replace(":id", encodeURIComponent(stopId)),
            { time, minutes: "5" },
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
    async geometry(tripId, from, to, signal) {
      try {
        const envelope = await client.get<MobilityEnvelope<GeoJSONLineString>>(
          API_ENDPOINTS.transitLegGeometry,
          { trip_id: tripId, from_stop_id: from, to_stop_id: to },
          options(signal),
        );
        const geometry = data(envelope);
        return {
          ...geometry,
          contributors: captureResultContributors(geometry, envelope.attributions),
        };
      } catch (error) {
        if (isApiClientError(error) && error.status === 404) return null;
        throw error;
      }
    },
  };
}
