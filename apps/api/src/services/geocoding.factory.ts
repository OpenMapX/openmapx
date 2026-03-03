import type { GeocodingProvider } from "./geocoding.provider";
import { maptilerGeocodingService } from "./maptiler-geocoding.service";
import { nominatimService } from "./nominatim.service";
import { peliasService } from "./pelias.service";
import { photonService } from "./photon.service";

type ProviderName = "maptiler" | "nominatim" | "pelias" | "photon";

const providers: Record<ProviderName, GeocodingProvider> = {
  maptiler: maptilerGeocodingService,
  nominatim: nominatimService,
  pelias: peliasService,
  photon: photonService,
};

function isProviderName(value: string): value is ProviderName {
  return value in providers;
}

export function getGeocodingProvider(): GeocodingProvider {
  const raw = (process.env.GEOCODING_PROVIDER ?? "maptiler").toLowerCase();
  if (!isProviderName(raw)) {
    throw new Error(
      `Unknown GEOCODING_PROVIDER: "${raw}". Valid options: maptiler, nominatim, pelias, photon`,
    );
  }
  return providers[raw];
}
