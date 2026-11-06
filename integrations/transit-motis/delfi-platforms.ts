/** Exact upstream defects captured 2026-11-06; never infer a passenger track from an ID. */
const BAD_CODES: Readonly<Record<string, string>> = {
  "de:05362:87303:2:23": "37",
  "de:05315:14201:7:73": "78",
  "de:05315:11901:7:74": "87",
  "de:05315:19201:7:73": "81",
  "de:05316:21101:7:75": "80",
};
const DELFI_STOP = /^(?:de-DELFI|de_DELFI)_(de:\d{5}:\d+)(?::[A-Za-z0-9]+){0,2}$/;

export function delfiStationRoot(rawStopId: string): string | undefined {
  return DELFI_STOP.exec(rawStopId)?.[1];
}

export function quarantinedDelfiTrack(
  rawStopId: string | undefined,
  code: string | undefined,
): string | undefined {
  if (!rawStopId || !DELFI_STOP.test(rawStopId)) return code;
  const dhid = rawStopId.replace(/^(?:de-DELFI|de_DELFI)_/, "");
  return BAD_CODES[dhid] === code ? undefined : code;
}

export function motisPlatform(place: { stopId?: string; track?: string; scheduledTrack?: string }) {
  const scheduledPlatform = quarantinedDelfiTrack(place.stopId, place.scheduledTrack);
  const current = quarantinedDelfiTrack(place.stopId, place.track);
  return { platform: current ?? scheduledPlatform, scheduledPlatform };
}

export function delfiTripIdentity(
  id: string,
  legs: readonly {
    tripShortName?: string;
    routeShortName?: string;
    routeId?: string;
    source?: string;
  }[],
) {
  const match = /^(\d{4})(\d{2})(\d{2})_\d{2}:\d{2}_(de-DELFI|de_DELFI)_/.exec(id);
  const leg = legs[0];
  if (
    !match ||
    legs.length !== 1 ||
    !/^\d{1,6}$/.test(leg?.tripShortName ?? "") ||
    !leg?.routeShortName ||
    !leg.routeId
  )
    return undefined;
  if (leg.source && !leg.source.startsWith("de_DELFI.gtfs.zip/")) return undefined;
  const serviceDate = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${serviceDate}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== serviceDate)
    return undefined;
  return {
    serviceDate,
    trainNumber: String(Number(leg.tripShortName)),
    lineName: leg.routeShortName,
    routeId: leg.routeId,
    feedTag: match[4],
  };
}
