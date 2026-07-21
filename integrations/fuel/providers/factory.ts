import type { BoundingBox } from "@openmapx/core";
import type { Logger } from "@openmapx/integration-framework";
import type { FuelStation } from "@openmapx/mobility-core/fuel";
import { AtEcontrolService } from "./at-econtrol.service";
import { DeTankerkoenigService } from "./de-tankerkoenig.service";
import { EsMineturService } from "./es-minetur.service";
import { FrPrixcarburantsService } from "./fr-prixcarburants.service";
import type { FuelPriceProvider } from "./price-provider";

const ALL_PROVIDERS: FuelPriceProvider[] = [
  new FrPrixcarburantsService(),
  new EsMineturService(),
  new AtEcontrolService(),
];

let log: Logger | null = null;

export function setFuelLogger(logger: Logger): void {
  log = logger;
}

// Populated by setup(ctx) from the resolved integration config cascade.
let _deTankerkoenigKey: string | undefined;
let _deTankerkoenig: FuelPriceProvider | null | undefined;

export function setDeTankerkoenigApiKey(value: string | undefined): void {
  _deTankerkoenigKey = value && value.length > 0 ? value : undefined;
  // Reset the memoised provider so the next call picks up the new key.
  _deTankerkoenig = undefined;
}

function getDeTankerkoenig(): FuelPriceProvider | null {
  if (_deTankerkoenig !== undefined) return _deTankerkoenig;
  _deTankerkoenig = _deTankerkoenigKey ? new DeTankerkoenigService(_deTankerkoenigKey) : null;
  return _deTankerkoenig;
}

export function getDeTankerkoenigApiKey(): string | undefined {
  return _deTankerkoenigKey;
}

function activeProviders(bbox: BoundingBox): FuelPriceProvider[] {
  const providers: FuelPriceProvider[] = [];
  const tk = getDeTankerkoenig();
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
      log?.warn(`fuel source ${providers[i].name} failed`, r.reason);
    }
  }
  if (
    providers.length > 0 &&
    stations.length === 0 &&
    results.every((r) => r.status === "rejected")
  ) {
    log?.error("all fuel sources failed");
  }

  return stations.length > 0 ? deduplicate(stations) : null;
}
