import type { HttpClient, UpstreamRuntime } from "@openmapx/integration-framework";
import {
  createDynamicGtfsClient,
  createDynamicTransmodelClient,
  OtpError,
} from "@openmapx/otp-client";
import type { RegisteredProtocolAdapter } from "./adapter-types";
import {
  gtfsDepartures,
  gtfsNearby,
  gtfsStop,
  required,
  trufiDepartures,
  trufiNearby,
  trufiStop,
} from "./otp-mapping";
import { publicOtpPolicy, resolveOtpProfile } from "./otp-profiles";
import type { RegistryEntry } from "./registry-types";

interface Options {
  http: HttpClient;
  upstreamRuntime?: UpstreamRuntime;
  signal: AbortSignal;
  digitransitApiKey?: unknown;
  isSourceAllowed: (entry: RegistryEntry, sourceId: string) => Promise<boolean>;
}
function integer(value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OtpError("input");
  return value;
}
function stopId(entry: RegistryEntry, id: string) {
  if (!id.startsWith(entry.prefix)) throw new OtpError("input");
  const raw = id.slice(entry.prefix.length);
  if (!raw.trim() || raw.length > 1024) throw new OtpError("input");
  return raw;
}
/** Only the three capabilities actually registered by the dynamic integration. */
export function createOtpGraphQlAdapter(options: Options): RegisteredProtocolAdapter {
  // Capture key and generation dependencies; later config mutation cannot retarget credentials.
  const apiKey = options.digitransitApiKey;
  function clients(entry: RegistryEntry) {
    const profile = resolveOtpProfile(entry);
    const transport = {
      ...options,
      ...publicOtpPolicy(profile, apiKey, options.upstreamRuntime),
      endpoint: profile.endpoint,
      isSourceAllowed: () => options.isSourceAllowed(entry, profile.sourceId),
    };
    return profile.family === "trufi"
      ? { kind: "trufi" as const, sdk: createDynamicTransmodelClient(transport) }
      : { kind: "gtfs" as const, sdk: createDynamicGtfsClient(profile.family, transport) };
  }
  return {
    async assertAvailable(entry) {
      await clients(entry).sdk.assertAvailable();
    },
    async getStopsNearby(entry, lat, lon, radius) {
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180
      )
        throw new OtpError("input");
      integer(radius, 1, 50000);
      const client = clients(entry),
        variables = { lat, lon, radius, limit: 20 };
      return client.kind === "trufi"
        ? trufiNearby(entry, await client.sdk.DynamicNearby(variables))
        : gtfsNearby(entry, await client.sdk.DynamicNearby(variables));
    },
    async getDepartures(entry, id, minutes) {
      const raw = stopId(entry, id);
      integer(minutes, 1, 1440);
      const client = clients(entry),
        start = Math.floor(Date.now() / 1000),
        variables = { id: raw, range: minutes * 60, limit: 100 };
      const departures =
        client.kind === "trufi"
          ? trufiDepartures(
              entry,
              raw,
              await client.sdk.DynamicDepartures({
                ...variables,
                start: new Date(start * 1000).toISOString(),
              }),
            )
          : gtfsDepartures(entry, raw, await client.sdk.DynamicDepartures({ ...variables, start }));
      return departures
        .filter((call) => {
          const time = Date.parse(call.expectedAt ?? call.scheduledAt);
          return time >= start * 1000 && time <= (start + variables.range) * 1000;
        })
        .sort(
          (a, b) =>
            Date.parse(a.expectedAt ?? a.scheduledAt) - Date.parse(b.expectedAt ?? b.scheduledAt),
        );
    },
    async searchByName(entry, name, limit) {
      if (typeof name !== "string" || !name.trim() || name.length > 256)
        throw new OtpError("input");
      integer(limit, 1, 100);
      const client = clients(entry),
        variables = { name: name.trim() };
      return client.kind === "trufi"
        ? required((await client.sdk.DynamicSearch(variables)).quays)
            .map((stop) => trufiStop(entry, required(stop)))
            .slice(0, limit)
        : required((await client.sdk.DynamicSearch(variables)).stops)
            .map((stop) => gtfsStop(entry, required(stop)))
            .slice(0, limit);
    },
  };
}
