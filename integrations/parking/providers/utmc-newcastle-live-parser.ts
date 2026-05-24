import type { PoiLiveParseFn, PoiLiveState } from "@openmapx/poi-source-registry";

/**
 * UTMC Tyne & Wear dynamic feed.
 *
 * Per Tyne and Wear Open Data Services Platform API Specification
 * (Mott MacDonald, October 2019) section 6.4: the response is always a bare
 * JSON array of UtmcDynamicCarPark records. The PoiLiveState carries the
 * raw occupancy + stateDescription; mergeUtmcLive derives freeSpaces and
 * the canonical state enum from there + the static capacity.
 */

interface UtmcDynamicCarPark {
  systemCodeNumber: string;
  dynamics: Array<{
    occupancy?: number;
    stateDescription?: string;
    lastUpdated?: string;
  }>;
}

export const parseUtmcLive: PoiLiveParseFn = (buffer) => {
  const text = buffer.toString("utf-8");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return new Map<string, PoiLiveState>();
  }
  if (!Array.isArray(data)) return new Map<string, PoiLiveState>();

  const out = new Map<string, PoiLiveState>();
  const fallbackAsOf = new Date().toISOString();
  for (const record of data as UtmcDynamicCarPark[]) {
    if (!record?.systemCodeNumber) continue;
    const dyn = record.dynamics?.[0];
    if (!dyn) continue;
    if (dyn.occupancy == null && !dyn.stateDescription) continue;
    out.set(record.systemCodeNumber, {
      asOf: dyn.lastUpdated ?? fallbackAsOf,
      occupancy: dyn.occupancy,
      stateDescription: dyn.stateDescription,
    });
  }
  return out;
};
