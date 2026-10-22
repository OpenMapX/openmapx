import type {
  Departure,
  Facility,
  ServiceAlert,
  TransitStop,
  TransportMode,
  VehiclePosition,
} from "@openmapx/mobility-core/transit";
import type {
  AlertResource,
  FacilityResource,
  Predictions,
  RouteResource,
  ScheduleResource,
  StopResource,
  TripResource,
  VehicleResource,
} from "./generated/models";

const MODES: Readonly<Record<number, TransportMode>> = {
  0: "tram",
  1: "subway",
  2: "rail",
  3: "bus",
  4: "ferry",
};
const coordinate = (value: unknown, limit: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
const validTime = (value: string | null | undefined): value is string =>
  !!value && Number.isFinite(Date.parse(value));
export const rawId = (id: string) => (id.startsWith("mb:") ? id.slice(3) : id);
const prefixed = (id: string) => `mb:${id}`;
/** Conservative flat-degree candidate circle; final membership uses the shared haversine helper. */
export function angularRadius(latitude: number, metres: number): number {
  const angular = ((metres / 6371000) * 180) / Math.PI;
  return angular / Math.cos((Math.min(89.999, Math.abs(latitude) + angular) * Math.PI) / 180);
}
export function mapStop(resource: StopResource): TransitStop | null {
  const attrs = resource.attributes;
  const lat = attrs?.latitude;
  const lng = attrs?.longitude;
  if (!coordinate(lat, 90) || !coordinate(lng, 180)) return null;
  return {
    id: prefixed(resource.id),
    name: attrs?.name ?? "Unknown",
    lat,
    lng,
    modes: [MODES[attrs?.vehicle_type ?? 3] ?? "bus"],
    platformCode: attrs?.platform_code ?? undefined,
    parentStationId: resource.relationships?.parent_station?.data?.id
      ? prefixed(resource.relationships.parent_station.data.id)
      : undefined,
    provider: "mb",
  };
}
export function mapVehicle(resource: VehicleResource, routeId: string): VehiclePosition | null {
  const attrs = resource.attributes;
  const lat = attrs?.latitude;
  const lng = attrs?.longitude;
  if (!coordinate(lat, 90) || !coordinate(lng, 180) || !validTime(attrs?.updated_at)) return null;
  const trip = resource.relationships?.trip?.data?.id;
  const stop = resource.relationships?.stop?.data?.id;
  const route = resource.relationships?.route?.data?.id ?? rawId(routeId);
  return {
    id: prefixed(resource.id),
    provider: "mb",
    lat,
    lng,
    bearing: attrs.bearing ?? undefined,
    speed: attrs.speed ?? undefined,
    label: attrs.label ?? undefined,
    tripId: trip ? prefixed(trip) : undefined,
    routeId: prefixed(route),
    currentStopId: stop ? prefixed(stop) : undefined,
    currentStopSequence: attrs.current_stop_sequence ?? undefined,
    updatedAt: attrs.updated_at,
  };
}
export function mapDepartures(
  page: Pick<Predictions, "data" | "included">,
  minutes: number,
  now = Date.now(),
): Departure[] {
  const routes = new Map<string, RouteResource>();
  const schedules = new Map<string, ScheduleResource>();
  const trips = new Map<string, TripResource>();
  const stops = new Map<string, StopResource>();
  for (const value of page.included ?? []) {
    if (value.type === "route") routes.set(value.id, value);
    else if (value.type === "schedule") schedules.set(value.id, value);
    else if (value.type === "trip") trips.set(value.id, value);
    else if (value.type === "stop") stops.set(value.id, value);
  }
  const result: Departure[] = [];
  for (const prediction of page.data) {
    const rel = prediction.relationships;
    const routeId = rel?.route?.data?.id;
    const tripId = rel?.trip?.data?.id;
    const route = routeId ? routes.get(routeId)?.attributes : undefined;
    const mode = route?.type === undefined ? undefined : MODES[route.type];
    if (!routeId || !tripId || !mode) continue;
    const predicted = prediction.attributes?.departure_time ?? prediction.attributes?.arrival_time;
    const expected = validTime(predicted) ? predicted : undefined;
    const schedule = rel?.schedule?.data?.id
      ? schedules.get(rel.schedule.data.id)?.attributes
      : undefined;
    const planned = schedule?.departure_time ?? schedule?.arrival_time;
    const scheduled = validTime(planned) ? planned : undefined;
    const when = expected ?? scheduled;
    if (!when || Date.parse(when) < now || Date.parse(when) > now + minutes * 60000) continue;
    const delay =
      scheduled && expected
        ? Math.round((Date.parse(expected) - Date.parse(scheduled)) / 1000)
        : undefined;
    const trip = trips.get(tripId)?.attributes;
    const stop = rel?.stop?.data?.id ? stops.get(rel.stop.data.id)?.attributes : undefined;
    const color = route?.color?.replace(/^#/, "");
    result.push({
      tripId: prefixed(tripId),
      route: {
        id: prefixed(routeId),
        shortName: route?.short_name || routeId,
        longName: route?.long_name ?? "",
        mode,
        color: color && /^[0-9a-f]{6}$/i.test(color) ? color : undefined,
      },
      headsign: prediction.attributes?.trip_headsign || trip?.headsign || "",
      scheduledAt: scheduled ?? when,
      expectedAt: expected !== scheduled ? expected : undefined,
      delaySeconds: delay || undefined,
      platform: stop?.platform_code ?? undefined,
      canceled: ["CANCELLED", "SKIPPED"].includes(
        prediction.attributes?.schedule_relationship ?? "",
      ),
    });
  }
  return result.sort(
    (a, b) => Date.parse(a.expectedAt ?? a.scheduledAt) - Date.parse(b.expectedAt ?? b.scheduledAt),
  );
}
export function mapAlert(resource: AlertResource): ServiceAlert {
  const attrs = resource.attributes;
  const severity = attrs?.severity ?? 1;
  return {
    id: prefixed(resource.id),
    providers: ["mb"],
    severity:
      severity <= 3 ? "info" : severity <= 6 ? "warning" : severity <= 9 ? "severe" : "critical",
    effect: attrs?.effect ?? undefined,
    title: attrs?.header ?? "",
    description: attrs?.description ?? undefined,
    affectedRouteIds: (attrs?.informed_entity ?? []).flatMap((entity) =>
      entity.route ? [prefixed(entity.route)] : [],
    ),
    affectedStopIds: (attrs?.informed_entity ?? []).flatMap((entity) =>
      entity.stop ? [prefixed(entity.stop)] : [],
    ),
    activePeriods: (attrs?.active_period ?? []).map((period) => ({
      start: period.start,
      end: period.end ?? undefined,
    })),
  };
}
export function mapFacility(resource: FacilityResource, stopId: string): Facility {
  const attrs = resource.attributes;
  const access = (attrs?.properties ?? []).find(
    (value) => value.name === "accessibility-accessible",
  );
  return {
    id: prefixed(resource.id),
    stopId: prefixed(rawId(stopId)),
    name: attrs?.long_name ?? attrs?.short_name ?? resource.id,
    type:
      attrs?.type === "ELEVATOR" ? "elevator" : attrs?.type === "ESCALATOR" ? "escalator" : "other",
    isAccessible: access ? access.value === 1 : true,
    provider: "mb",
  };
}
