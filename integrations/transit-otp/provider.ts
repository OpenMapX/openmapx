import type { TripPlan } from "@openmapx/mobility-core/transit";
import {
  type OtpClient,
  OtpError,
  type PlanModesInput,
  type TransitMode,
} from "@openmapx/otp-client";
import { z } from "zod";
import { mapItinerary } from "./mapping";

export interface TripPlanParams {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  departureTime?: string;
  arrivalTime?: string;
  modes?: string[];
  numItineraries?: number;
}
const modes: Record<string, TransitMode> = {
  HIGHSPEED_RAIL: "RAIL",
  LONG_DISTANCE: "RAIL",
  NIGHT_RAIL: "RAIL",
  REGIONAL_FAST_RAIL: "RAIL",
  REGIONAL_RAIL: "RAIL",
  SUBURBAN: "RAIL",
  SUBWAY: "SUBWAY",
  TRAM: "TRAM",
  BUS: "BUS",
  COACH: "BUS",
  FERRY: "FERRY",
  FUNICULAR: "FUNICULAR",
  AERIAL_LIFT: "GONDOLA",
};
export function motisModesToOtp(values?: string[]): PlanModesInput | undefined {
  if (!values?.length) return undefined;
  const selected = [...new Set(values.flatMap((mode) => (modes[mode] ? [modes[mode]] : [])))];
  return selected.length
    ? {
        direct: ["WALK"],
        transit: {
          access: ["WALK"],
          egress: ["WALK"],
          transfer: ["WALK"],
          transit: selected.map((mode) => ({ mode })),
        },
      }
    : undefined;
}
const coordinate = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
const input = z.object({
  from: coordinate,
  to: coordinate,
  departureTime: z.iso.datetime({ offset: true }).optional(),
  arrivalTime: z.iso.datetime({ offset: true }).optional(),
  numItineraries: z.number().int().min(1).max(50).optional(),
});
export function createOtpProvider(client: OtpClient) {
  return {
    async plan(params: TripPlanParams): Promise<TripPlan> {
      if (!input.safeParse(params).success) throw new OtpError("input");
      const when = params.arrivalTime ?? params.departureTime ?? new Date().toISOString();
      const result = await client.sdk.OtpPlan({
        origin: {
          location: { coordinate: { latitude: params.from.lat, longitude: params.from.lng } },
        },
        destination: {
          location: { coordinate: { latitude: params.to.lat, longitude: params.to.lng } },
        },
        dateTime: params.arrivalTime ? { latestArrival: when } : { earliestDeparture: when },
        modes: motisModesToOtp(params.modes),
        first: params.numItineraries ?? 3,
      });
      await client.assertAvailable();
      const connection = result.planConnection;
      if (!connection?.edges) throw new OtpError("payload");
      if (
        connection.routingErrors.some(({ code }) => code !== "WALKING_BETTER_THAN_TRANSIT") ||
        (connection.routingErrors.length > 0 && connection.edges.length === 0)
      )
        throw new OtpError("routing");
      return {
        from: { name: "", ...params.from },
        to: { name: "", ...params.to },
        itineraries: connection.edges.map((edge) => {
          if (!edge) throw new OtpError("payload");
          return mapItinerary(edge.node);
        }),
      };
    },
  };
}
