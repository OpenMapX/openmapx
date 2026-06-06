import type { LngLat } from "../types/geometry";
import { useCountryFromCoordinates } from "./useCountryFromCoordinates";

/**
 * Resolve whether both endpoints of a route lie in Germany. Used to gate the
 * Deutschlandticket filter, which is a Germany-only feature. Each endpoint is
 * resolved via {@link useCountryFromCoordinates} (a cached Nominatim reverse
 * lookup, 24h staleTime); React Query dedupes so multiple callers share one
 * request per coordinate.
 */
export function useRouteInGermany(
  origin: LngLat | null,
  destination: LngLat | null,
): { bothInGermany: boolean; isResolving: boolean } {
  const originCountry = useCountryFromCoordinates(origin);
  const destinationCountry = useCountryFromCoordinates(destination);
  return {
    bothInGermany: originCountry.data === "de" && destinationCountry.data === "de",
    isResolving: originCountry.isLoading || destinationCountry.isLoading,
  };
}
