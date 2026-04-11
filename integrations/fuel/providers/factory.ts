import type { BoundingBox } from "@openmapx/core";
import { AustriaService } from "./austria.service";
import { FranceService } from "./france.service";
import type { FuelPriceProvider } from "./price-provider";
import { SpainService } from "./spain.service";
import { TankerkoenigService } from "./tankerkoenig.service";
import type { FuelStation } from "./types";

const ALL_PROVIDERS: FuelPriceProvider[] = [
  new FranceService(),
  new SpainService(),
  new AustriaService(),
];

let _tankerkoenig: FuelPriceProvider | null | undefined;

function getTankerkoenig(): FuelPriceProvider | null {
  if (_tankerkoenig !== undefined) return _tankerkoenig;
  const key = process.env.TANKERKOENIG_API_KEY;
  _tankerkoenig = key ? new TankerkoenigService(key) : null;
  return _tankerkoenig;
}

function activeProviders(bbox: BoundingBox): FuelPriceProvider[] {
  const providers: FuelPriceProvider[] = [];
  const tk = getTankerkoenig();
  if (tk?.supports(bbox)) providers.push(tk);
  for (const p of ALL_PROVIDERS) {
    if (p.supports(bbox)) providers.push(p);
  }
  return providers;
}

/**
 * Deduplicate stations from multiple providers by coordinates (≈11 m precision).
 * First-seen wins, so provider order matters only for duplicates at borders.
 */
function deduplicate(stations: FuelStation[]): FuelStation[] {
  const seen = new Set<string>();
  return stations.filter((s) => {
    const key = `${s.coordinates[0].toFixed(4)},${s.coordinates[1].toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Returns fuel stations with live prices for the given bbox, or null if no
 * provider covers this area. When multiple providers overlap (e.g. at the
 * German-Austrian border) they are all queried in parallel and their results
 * merged, with coordinate-based deduplication for physical duplicates.
 */
export async function searchFuelStations(bbox: BoundingBox): Promise<FuelStation[] | null> {
  const providers = activeProviders(bbox);
  if (providers.length === 0) return null;

  const results = await Promise.allSettled(providers.map((p) => p.searchStations(bbox)));

  const stations: FuelStation[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      stations.push(...r.value);
    } else {
      console.warn(`[fuel] Provider ${providers[i].name} failed:`, r.reason?.message ?? r.reason);
    }
  }

  return stations.length > 0 ? deduplicate(stations) : null;
}
