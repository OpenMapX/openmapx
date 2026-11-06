import { platformChanged } from "@openmapx/mobility-core/platform";
import type { JourneyPlatformUpdate, VehicleJourney } from "@openmapx/mobility-core/transit";
import { type SiriJourney, stationRoot } from "./siri-et-stream";

export const SOURCE_ID = "delfi-siri-et-rhein-ruhr";
const seconds = (value: string | undefined) => (value ? Date.parse(value) / 1000 : undefined);
const line = (value: string) => value.toUpperCase().replace(/\s/g, "");

/** Complete scheduled calls establish direction and occurrences; names never establish identity. */
export function matchJourneyPlatforms(
  journey: VehicleJourney,
  records: readonly SiriJourney[],
  now: number,
  fetchedAt = new Date(now).toISOString(),
): JourneyPlatformUpdate[] {
  const identity = journey.identity;
  if (!identity || !["de-DELFI", "de_DELFI"].includes(identity.feedTag) || journey.stops.length < 3)
    return [];
  const roots = journey.stops.map((s) =>
    stationRoot(
      s.stopId.replace(/^(?:ms:|mo:)/, "").replace(new RegExp(`^${identity.feedTag}_`), ""),
    ),
  );
  if (roots.some((root) => !root)) return [];
  const matches = records.filter(
    (r) =>
      r.serviceDate === identity.serviceDate &&
      r.trainNumber === identity.trainNumber &&
      line(r.lineName) === line(identity.lineName) &&
      r.complete &&
      !r.cancelled &&
      !r.extra &&
      r.calls.length === roots.length &&
      r.calls.every((c, i) => {
        const stop = journey.stops[i];
        return (
          !c.extra &&
          c.root === roots[i] &&
          (c.aa !== undefined || c.ad !== undefined) &&
          (c.aa === undefined || c.aa === seconds(stop.scheduledArrival)) &&
          (c.ad === undefined || c.ad === seconds(stop.scheduledDeparture))
        );
      }),
  );
  if (matches.length !== 1) return [];
  const record = matches[0];
  const stamp = Date.parse(record.recordedAt);
  if (!Number.isFinite(stamp) || stamp > now + 120_000 || now - stamp > 24 * 60 * 60_000) return [];
  return record.calls.map((call, stopIndex) => {
    const stop = journey.stops[stopIndex];
    const update: JourneyPlatformUpdate = { stopIndex };
    if (stop.canceled || call.cancelled) return update;
    const knownRealtime =
      !!stop.platform &&
      (!stop.scheduledPlatform || platformChanged(stop.scheduledPlatform, stop.platform));
    for (const event of ["arrival", "departure"] as const) {
      const code = event === "arrival" ? call.ap : call.dp;
      if (!code) continue;
      const predicted = event === "arrival" ? (call.ea ?? call.xa) : (call.ed ?? call.xd);
      const realtime = now - stamp <= 5 * 60_000 && predicted !== undefined;
      if (knownRealtime && (!realtime || stop.platform !== code)) continue;
      const correction = stop.platformQuarantined || platformChanged(stop.scheduledPlatform, code);
      update[event === "arrival" ? "arrivalPlatform" : "departurePlatform"] = {
        code,
        scheduledCode: realtime ? stop.scheduledPlatform : code,
        kind: realtime ? "realtime" : correction ? "correction" : "schedule",
        sourceId: SOURCE_ID,
        recordedAt: record.recordedAt,
        fetchedAt,
      };
    }
    return update;
  });
}
