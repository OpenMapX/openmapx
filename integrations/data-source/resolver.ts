/**
 * Builds a `PlaceResolver` for a data-source provider. When a client hits
 * `/api/places/<provider-id>:<item-id>` we look up the nearest OSM
 * element matching the provider's `osmFilters` (via Overpass) so the
 * Place panel can enrich with OSM-derived knowledge (wikidata, photos,
 * reviews). Falls back to a reverse-geocode for address-only details
 * when the provider has no OSM equivalent.
 *
 * Free-floating shared-mobility vehicles are explicitly excluded from the
 * Overpass snap: a scooter sitting on the sidewalk would otherwise inherit
 * the website / opening hours / wheelchair tags of the nearest matching
 * OSM POI. Shared-mobility results tag these items with a `v:` id prefix;
 * stations use `s:`.
 */

import { createPlace } from "@openmapx/core";
import type { MobilityDataSourceProvider, OsmIdentity } from "@openmapx/integration-framework";
import { VEHICLE_ID_PREFIX } from "@openmapx/integration-framework/shared-mobility";
import {
  lookupAddressByCoords,
  lookupByOsmFilters,
} from "@openmapx/integration-geocoding/place-lookup";
import type { PlaceResolver } from "@openmapx/place-ids";

async function fetchIdentity(
  provider: MobilityDataSourceProvider,
  itemId: string,
): Promise<OsmIdentity | undefined> {
  try {
    const detail = await provider.getDetail(itemId);
    return detail.data?.identity;
  } catch {
    return undefined;
  }
}

export function createDataSourceResolver(provider: MobilityDataSourceProvider): PlaceResolver {
  const scheme = provider.id;
  const osmFilters = provider.meta.osmFilters;

  return async (value, ctx) => {
    // Resolver needs coordinates to run — the client always has them on
    // hand (the marker it clicked came with lat/lng in its feature props).
    const { lat, lng, hasAddress } = ctx;
    if (lat === undefined || lng === undefined) return null;

    const isVehicle = value.startsWith(VEHICLE_ID_PREFIX);

    // When the provider supplies an identity for the item (operator / ref /
    // network / brand), constrain the OSM snap to candidates that match it.
    // Providers without an identity hint use an unconstrained nearest match;
    // the gate inside `lookupByOsmFilters` ignores identity when none is passed.
    const identity = osmFilters && !isVehicle ? await fetchIdentity(provider, value) : undefined;

    // Providers without an OSM equivalent (webcams, scooters, …) skip the
    // Overpass lookup and return an address-only Place so the panel can
    // still show something sensible. Free-floating vehicles take the same
    // path even when the provider's stations would normally snap to OSM.
    let place =
      osmFilters && !isVehicle
        ? await lookupByOsmFilters(lat, lng, osmFilters, `${scheme}:${value}`, identity)
        : null;

    // Skip the reverse-geocode fallback when the caller already has an
    // address — data-source items supply their own, and the client merge
    // keeps those over any OSM-derived address anyway. Avoids a Nominatim
    // + possible Overpass call on every cold fetch. Vehicles are the
    // exception: their preview `address` is the marker label ("Dott
    // E-Scooter"), not a real street address, so always pull one.
    if (!place?.address && (isVehicle || !hasAddress)) {
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
