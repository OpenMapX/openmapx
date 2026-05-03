import { createRequire } from "node:module";
import type * as GtfsRealtimeBindings from "gtfs-realtime-bindings-transit";

// The published `gtfs-realtime-bindings-transit` package only exports a
// `require` condition, so a static ESM `import` would fail under Node's
// exports-field resolution. createRequire keeps interop simple at the cost
// of needing the package to live somewhere on Node's resolution path at
// runtime — apps/api lists it directly in its dependencies so esbuild
// externalises the require() and pnpm symlinks the package under
// apps/api/node_modules.
const require = createRequire(import.meta.url);
const bindings = require("gtfs-realtime-bindings-transit") as typeof GtfsRealtimeBindings;

const { transit_realtime: gtfsRt } = bindings;

export type GtfsRtFeedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage;
export type GtfsRtFeedEntity = GtfsRealtimeBindings.transit_realtime.FeedEntity;
export type GtfsRtTripUpdate = GtfsRealtimeBindings.transit_realtime.TripUpdate;
export type GtfsRtVehiclePosition = GtfsRealtimeBindings.transit_realtime.VehiclePosition;
export type GtfsRtAlert = GtfsRealtimeBindings.transit_realtime.Alert;
export type GtfsRtFeedObject = ReturnType<typeof gtfsRt.FeedMessage.toObject>;

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/**
 * Decode a GTFS-RT protobuf feed into the generated message class.
 */
export function decodeGtfsRtFeed(
  input: Uint8Array | ArrayBuffer,
): GtfsRealtimeBindings.transit_realtime.FeedMessage {
  return gtfsRt.FeedMessage.decode(toUint8Array(input));
}

/**
 * Decode GTFS-RT and return a plain JS object with Long values coerced to
 * strings and enums coerced to strings for easier downstream mapping.
 */
export function decodeGtfsRtFeedToObject(input: Uint8Array | ArrayBuffer): GtfsRtFeedObject {
  const feed = decodeGtfsRtFeed(input);
  return gtfsRt.FeedMessage.toObject(feed, {
    enums: String,
    longs: String,
    oneofs: true,
  });
}

export function encodeGtfsRtFeed(
  message: GtfsRealtimeBindings.transit_realtime.IFeedMessage,
): Uint8Array {
  const error = gtfsRt.FeedMessage.verify(message as unknown as { [key: string]: unknown });
  if (error) throw new Error(`Invalid GTFS-RT feed: ${error}`);
  return gtfsRt.FeedMessage.encode(message).finish();
}

export function gtfsRtTimestampToIso(
  value: number | string | null | undefined,
): string | undefined {
  if (value == null) return undefined;
  const seconds = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (!Number.isFinite(seconds)) return undefined;
  return new Date(seconds * 1000).toISOString();
}

export function getGtfsRtTripUpdates(
  feed: GtfsRealtimeBindings.transit_realtime.FeedMessage,
): GtfsRealtimeBindings.transit_realtime.TripUpdate[] {
  return feed.entity
    .map((entity) => entity.tripUpdate)
    .filter((tripUpdate): tripUpdate is GtfsRealtimeBindings.transit_realtime.TripUpdate =>
      Boolean(tripUpdate),
    );
}

export function getGtfsRtVehiclePositions(
  feed: GtfsRealtimeBindings.transit_realtime.FeedMessage,
): GtfsRealtimeBindings.transit_realtime.VehiclePosition[] {
  return feed.entity
    .map((entity) => entity.vehicle)
    .filter((vehicle): vehicle is GtfsRealtimeBindings.transit_realtime.VehiclePosition =>
      Boolean(vehicle),
    );
}

export function getGtfsRtAlerts(
  feed: GtfsRealtimeBindings.transit_realtime.FeedMessage,
): GtfsRealtimeBindings.transit_realtime.Alert[] {
  return feed.entity
    .map((entity) => entity.alert)
    .filter((alert): alert is GtfsRealtimeBindings.transit_realtime.Alert => Boolean(alert));
}
