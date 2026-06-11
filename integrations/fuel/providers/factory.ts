import type { BoundingBox } from "@openmapx/core";
import type { Logger } from "@openmapx/integration-framework";
import type { FuelStation } from "@openmapx/mobility-core/fuel";
import { AustriaService } from "./austria.service";
import { FranceService } from "./france.service";
import type { FuelPriceProvider } from "./price-provider";
import { SpainService } from "./spain.service";
import { TankerkoenigService } from "./tankerkoenig.service";

const ALL_PROVIDERS: FuelPriceProvider[] = [
  new FranceService(),
  new SpainService(),
  new AustriaService(),
];

let log: Logger | null = null;

export function setFuelLogger(logger: Logger): void {
  log = logger;
}

// Populated by setup(ctx) from the resolved integration config cascade.
let _tankerkoenigKey: string | undefined;
let _tankerkoenig: FuelPriceProvider | null | undefined;

export function setTankerkoenigApiKey(value: string | undefined): void {
  _tankerkoenigKey = value && value.length > 0 ? value : undefined;
  // Reset the memoised provider so the next call picks up the new key.
  _tankerkoenig = undefined;
}

function getTankerkoenig(): FuelPriceProvider | null {
  if (_tankerkoenig !== undefined) return _tankerkoenig;
  _tankerkoenig = _tankerkoenigKey ? new TankerkoenigService(_tankerkoenigKey) : null;
  return _tankerkoenig;
}

export function getTankerkoenigApiKey(): string | undefined {
  return _tankerkoenigKey;
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
