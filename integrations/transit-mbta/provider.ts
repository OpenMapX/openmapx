import { haversineMeters } from "@openmapx/mobility-core/geo";
import type { MbtaClient } from "./client";
import { PAGE_SIZE } from "./client";
import { MbtaError } from "./errors";
import {
  apiWebAlertControllerIndex,
  apiWebFacilityControllerIndex,
  apiWebPredictionControllerIndex,
  apiWebStopControllerIndex,
  apiWebStopControllerShow,
  apiWebVehicleControllerIndex,
  getApiWebAlertControllerIndexUrl,
  getApiWebFacilityControllerIndexUrl,
  getApiWebPredictionControllerIndexUrl,
  getApiWebStopControllerIndexUrl,
  getApiWebVehicleControllerIndexUrl,
} from "./generated/client";
import {
  angularRadius,
  mapAlert,
  mapDepartures,
  mapFacility,
  mapStop,
  mapVehicle,
  rawId,
} from "./mapping";
import type { MbtaRequestOptions } from "./transport";

interface Resource {
  type: string;
  id: string;
}
interface Page<R, I> {
  data: R[];
  included?: I[];
  links?: { next?: string | null };
}
function id(value: string): string {
  const raw = rawId(value);
  if (
    !raw ||
    raw.length > 512 ||
    raw.trim() !== raw ||
    [...raw].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new MbtaError("input");
  return raw;
}
export function createMbtaProvider(client: MbtaClient) {
  function list<P extends object, R extends Resource, I extends Resource>(
    getUrl: (params?: P) => string,
    operation: (params?: P, options?: MbtaRequestOptions) => Promise<Page<R, I>>,
    params: P,
  ) {
    const first = { ...params, "page[limit]": PAGE_SIZE, "page[offset]": 0 };
    return client.collect(getUrl(first), (offset, signal) =>
      operation({ ...first, "page[offset]": offset }, { client, signal }),
    );
  }
  return {
    async getStops(lat: number, lng: number, radiusMeters: number) {
      if (
        !Number.isFinite(lat) ||
        Math.abs(lat) >= 90 ||
        !Number.isFinite(lng) ||
        Math.abs(lng) > 180 ||
        !Number.isFinite(radiusMeters) ||
        radiusMeters <= 0 ||
        radiusMeters > 100000
      )
        throw new MbtaError("input");
      if (!client.configured) return [];
      const page = await list(getApiWebStopControllerIndexUrl, apiWebStopControllerIndex, {
        "filter[latitude]": String(lat),
        "filter[longitude]": String(lng),
        "filter[radius]": angularRadius(lat, radiusMeters),
      });
      return page.data.flatMap((value) => {
        const stop = mapStop(value);
        return stop && haversineMeters(lat, lng, stop.lat, stop.lng) <= radiusMeters ? [stop] : [];
      });
    },
    async getStop(stopId: string) {
      const raw = id(stopId);
      if (!client.configured) return null;
      try {
        const page = await apiWebStopControllerShow(raw, {}, { client });
        return mapStop(page.data);
      } catch (error) {
        if (error instanceof MbtaError && error.kind === "not_found") return null;
        throw error;
      }
    },
    async getDepartures(stopId: string, minutes: number) {
      const raw = id(stopId);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) throw new MbtaError("input");
      if (!client.configured) return [];
      const page = await list(
        getApiWebPredictionControllerIndexUrl,
        apiWebPredictionControllerIndex,
        { "filter[stop]": raw, include: "route,schedule,trip,stop" },
      );
      return mapDepartures(page, minutes);
    },
    async getVehiclePositions(routeId: string) {
      const raw = id(routeId);
      if (!client.configured) return [];
      const page = await list(getApiWebVehicleControllerIndexUrl, apiWebVehicleControllerIndex, {
        "filter[route]": raw,
      });
      return page.data.flatMap((value) => {
        const vehicle = mapVehicle(value, raw);
        return vehicle ? [vehicle] : [];
      });
    },
    async getAlerts(opts: { stopId: string } | { routeId: string }) {
      const filter =
        "stopId" in opts
          ? { "filter[stop]": id(opts.stopId) }
          : { "filter[route]": id(opts.routeId) };
      if (!client.configured) return [];
      const page = await list(getApiWebAlertControllerIndexUrl, apiWebAlertControllerIndex, {
        ...filter,
        "filter[activity]": "BOARD",
      });
      return page.data.map(mapAlert);
    },
    async getFacilities(stopId: string) {
      const raw = id(stopId);
      if (!client.configured) return [];
      const page = await list(getApiWebFacilityControllerIndexUrl, apiWebFacilityControllerIndex, {
        "filter[stop]": raw,
        "filter[type]": "ELEVATOR,ESCALATOR",
      });
      return page.data.map((value) => mapFacility(value, raw));
    },
    async probe() {
      await apiWebStopControllerIndex(
        {
          "filter[latitude]": "42.36",
          "filter[longitude]": "-71.06",
          "filter[radius]": 0.01,
          "page[limit]": 1,
        },
        { client },
      );
    },
  };
}
