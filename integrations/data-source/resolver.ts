/**
 * Builds a `PlaceResolver` for a data-source provider. When a client hits
 * `/api/places/<provider-id>:<item-id>` we look up the nearest OSM
 * element matching the provider's `osmFilters` (via Overpass) so the
 * Place panel can enrich with OSM-derived knowledge (wikidata, photos,
 * reviews). Falls back to a reverse-geocode for address-only details
 * when the provider has no OSM equivalent.
 */

import { createPlace } from "@openmapx/core";
import type { MobilityDataSourceProvider } from "@openmapx/integration-framework";
import {
  lookupAddressByCoords,
  lookupByOsmFilters,
} from "@openmapx/integration-geocoding/place-lookup";
import type { PlaceResolver } from "@openmapx/place-ids";

export function createDataSourceResolver(provider: MobilityDataSourceProvider): PlaceResolver {
  const scheme = provider.id;
  const osmFilters = provider.meta.osmFilters;

  return async (value, ctx) => {
    // Resolver needs coordinates to run — the client always has them on
    // hand (the marker it clicked came with lat/lng in its feature props).
    const { lat, lng, hasAddress } = ctx;
    if (lat === undefined || lng === undefined) return null;

    // Providers without an OSM equivalent (webcams, scooters, …) skip the
    // Overpass lookup and return an address-only Place so the panel can
    // still show something sensible.
    let place = osmFilters
      ? await lookupByOsmFilters(lat, lng, osmFilters, `${scheme}:${value}`)
      : null;

    // Skip the reverse-geocode fallback when the caller already has an
    // address — data-source items supply their own, and the client merge
    // keeps those over any OSM-derived address anyway. Avoids a Nominatim
    // + possible Overpass call on every cold fetch.
    if (!place?.address && !hasAddress) {
      const addrOnly = await lookupAddressByCoords(lat, lng);
      if (addrOnly) {
        if (place) {
          place = {
            ...place,
            address: addrOnly.address,
            city: addrOnly.city ?? place.city,
          };
        } else {
          place = createPlace({
            primaryScheme: scheme,
            ids: { [scheme]: value },
            name: "",
            address: addrOnly.address,
            city: addrOnly.city,
            coordinates: [lng, lat],
          });
        }
      }
    }

    // When Overpass returned nothing but the caller already has an address,
    // return a minimal placeholder so the route still runs enrichment
    // (photos, knowledge, review-links) and responds 200 instead of 404.
    // `address: ""` is just a required-field filler — the client merge
    // substitutes the data-source's own address.
    if (!place && hasAddress) {
      place = createPlace({
        primaryScheme: scheme,
        ids: { [scheme]: value },
        name: "",
        address: "",
        coordinates: [lng, lat],
      });
    }

    return place;
  };
}
