import { fileURLToPath } from "node:url";
import type { BuiltInManifestSource } from "./built-in-service-source";

/**
 * The ops-agent runtime bundle's variant of `embedded-built-in-services.ts`.
 *
 * The bundler copies every literal URL below into the bundle's `assets/`, so
 * the bundle digest, which the release build checks, covers each manifest. The
 * agent and the fixed CLI it runs ship in the same bundle directory and read
 * the same copies. Run from source, the URLs name the repository's own
 * manifests.
 */
export function embeddedBuiltInServiceManifests(): BuiltInManifestSource | null {
  return embeddedSource({
    "app-api": new URL("../../../../services/app-api/service.json", import.meta.url),
    "app-web": new URL("../../../../services/app-web/service.json", import.meta.url),
    brouter: new URL("../../../../services/brouter/service.json", import.meta.url),
    "data-manager": new URL("../../../../services/data-manager/service.json", import.meta.url),
    "dawarich-app": new URL("../../../../services/dawarich-app/service.json", import.meta.url),
    "dawarich-postgis": new URL(
      "../../../../services/dawarich-postgis/service.json",
      import.meta.url,
    ),
    "dawarich-redis": new URL("../../../../services/dawarich-redis/service.json", import.meta.url),
    "dawarich-sidekiq": new URL(
      "../../../../services/dawarich-sidekiq/service.json",
      import.meta.url,
    ),
    elasticsearch: new URL("../../../../services/elasticsearch/service.json", import.meta.url),
    "local-ai": new URL("../../../../services/local-ai/service.json", import.meta.url),
    martin: new URL("../../../../services/martin/service.json", import.meta.url),
    motis: new URL("../../../../services/motis/service.json", import.meta.url),
    "motis-feed-proxy": new URL(
      "../../../../services/motis-feed-proxy/service.json",
      import.meta.url,
    ),
    "motis-staging": new URL("../../../../services/motis-staging/service.json", import.meta.url),
    nominatim: new URL("../../../../services/nominatim/service.json", import.meta.url),
    "ops-agent": new URL("../../../../services/ops-agent/service.json", import.meta.url),
    osrm: new URL("../../../../services/osrm/service.json", import.meta.url),
    otp: new URL("../../../../services/otp/service.json", import.meta.url),
    overpass: new URL("../../../../services/overpass/service.json", import.meta.url),
    pelias: new URL("../../../../services/pelias/service.json", import.meta.url),
    "pelias-pip": new URL("../../../../services/pelias-pip/service.json", import.meta.url),
    "pelias-placeholder": new URL(
      "../../../../services/pelias-placeholder/service.json",
      import.meta.url,
    ),
    photon: new URL("../../../../services/photon/service.json", import.meta.url),
    postgis: new URL("../../../../services/postgis/service.json", import.meta.url),
    redis: new URL("../../../../services/redis/service.json", import.meta.url),
    tileserver: new URL("../../../../services/tileserver/service.json", import.meta.url),
    traefik: new URL("../../../../services/traefik/service.json", import.meta.url),
    "transitous-runner": new URL(
      "../../../../services/transitous-runner/service.json",
      import.meta.url,
    ),
    valhalla: new URL("../../../../services/valhalla/service.json", import.meta.url),
    "well-known": new URL("../../../../services/well-known/service.json", import.meta.url),
  });
}

/** The built-in integration manifests, `integrations/<id>/manifest.json`, embedded the same way. */
export function embeddedBuiltInIntegrationManifests(): BuiltInManifestSource | null {
  return embeddedSource({
    "air-quality": new URL("../../../../integrations/air-quality/manifest.json", import.meta.url),
    "air-quality-eccc": new URL(
      "../../../../integrations/air-quality-eccc/manifest.json",
      import.meta.url,
    ),
    "air-quality-uk-air": new URL(
      "../../../../integrations/air-quality-uk-air/manifest.json",
      import.meta.url,
    ),
    "bike-sharing": new URL("../../../../integrations/bike-sharing/manifest.json", import.meta.url),
    "border-crossings": new URL(
      "../../../../integrations/border-crossings/manifest.json",
      import.meta.url,
    ),
    "car-sharing": new URL("../../../../integrations/car-sharing/manifest.json", import.meta.url),
    "crowd-reports": new URL(
      "../../../../integrations/crowd-reports/manifest.json",
      import.meta.url,
    ),
    "data-source": new URL("../../../../integrations/data-source/manifest.json", import.meta.url),
    "ev-charging": new URL("../../../../integrations/ev-charging/manifest.json", import.meta.url),
    flights: new URL("../../../../integrations/flights/manifest.json", import.meta.url),
    "food-delivery": new URL(
      "../../../../integrations/food-delivery/manifest.json",
      import.meta.url,
    ),
    fuel: new URL("../../../../integrations/fuel/manifest.json", import.meta.url),
    geocoding: new URL("../../../../integrations/geocoding/manifest.json", import.meta.url),
    "geocoding-db-ris": new URL(
      "../../../../integrations/geocoding-db-ris/manifest.json",
      import.meta.url,
    ),
    "geocoding-entur": new URL(
      "../../../../integrations/geocoding-entur/manifest.json",
      import.meta.url,
    ),
    "geocoding-maptiler": new URL(
      "../../../../integrations/geocoding-maptiler/manifest.json",
      import.meta.url,
    ),
    "geocoding-motis": new URL(
      "../../../../integrations/geocoding-motis/manifest.json",
      import.meta.url,
    ),
    "geocoding-nominatim": new URL(
      "../../../../integrations/geocoding-nominatim/manifest.json",
      import.meta.url,
    ),
    "geocoding-pelias": new URL(
      "../../../../integrations/geocoding-pelias/manifest.json",
      import.meta.url,
    ),
    "geocoding-photon": new URL(
      "../../../../integrations/geocoding-photon/manifest.json",
      import.meta.url,
    ),
    hotels: new URL("../../../../integrations/hotels/manifest.json", import.meta.url),
    "knowledge-marine-weather": new URL(
      "../../../../integrations/knowledge-marine-weather/manifest.json",
      import.meta.url,
    ),
    "knowledge-noaa-tides": new URL(
      "../../../../integrations/knowledge-noaa-tides/manifest.json",
      import.meta.url,
    ),
    "knowledge-ourairports": new URL(
      "../../../../integrations/knowledge-ourairports/manifest.json",
      import.meta.url,
    ),
    "knowledge-overture": new URL(
      "../../../../integrations/knowledge-overture/manifest.json",
      import.meta.url,
    ),
    "knowledge-sun-time": new URL(
      "../../../../integrations/knowledge-sun-time/manifest.json",
      import.meta.url,
    ),
    "knowledge-tides-canada": new URL(
      "../../../../integrations/knowledge-tides-canada/manifest.json",
      import.meta.url,
    ),
    "knowledge-tides-ioc": new URL(
      "../../../../integrations/knowledge-tides-ioc/manifest.json",
      import.meta.url,
    ),
    "knowledge-tides-norway": new URL(
      "../../../../integrations/knowledge-tides-norway/manifest.json",
      import.meta.url,
    ),
    "knowledge-tides-pegelonline": new URL(
      "../../../../integrations/knowledge-tides-pegelonline/manifest.json",
      import.meta.url,
    ),
    "knowledge-wikidata": new URL(
      "../../../../integrations/knowledge-wikidata/manifest.json",
      import.meta.url,
    ),
    "knowledge-wikipedia": new URL(
      "../../../../integrations/knowledge-wikipedia/manifest.json",
      import.meta.url,
    ),
    "live-transit-db-ris": new URL(
      "../../../../integrations/live-transit-db-ris/manifest.json",
      import.meta.url,
    ),
    "live-transit-entur": new URL(
      "../../../../integrations/live-transit-entur/manifest.json",
      import.meta.url,
    ),
    "live-transit-motis": new URL(
      "../../../../integrations/live-transit-motis/manifest.json",
      import.meta.url,
    ),
    "live-transit-siri-sx-ch": new URL(
      "../../../../integrations/live-transit-siri-sx-ch/manifest.json",
      import.meta.url,
    ),
    "message-signs": new URL(
      "../../../../integrations/message-signs/manifest.json",
      import.meta.url,
    ),
    openconditions: new URL(
      "../../../../integrations/openconditions/manifest.json",
      import.meta.url,
    ),
    "overlay-3d-buildings": new URL(
      "../../../../integrations/overlay-3d-buildings/manifest.json",
      import.meta.url,
    ),
    "overlay-air-quality": new URL(
      "../../../../integrations/overlay-air-quality/manifest.json",
      import.meta.url,
    ),
    "overlay-ambient-places": new URL(
      "../../../../integrations/overlay-ambient-places/manifest.json",
      import.meta.url,
    ),
    "overlay-cycling": new URL(
      "../../../../integrations/overlay-cycling/manifest.json",
      import.meta.url,
    ),
    "overlay-earthquakes": new URL(
      "../../../../integrations/overlay-earthquakes/manifest.json",
      import.meta.url,
    ),
    "overlay-environment": new URL(
      "../../../../integrations/overlay-environment/manifest.json",
      import.meta.url,
    ),
    "overlay-hiking": new URL(
      "../../../../integrations/overlay-hiking/manifest.json",
      import.meta.url,
    ),
    "overlay-live-transit": new URL(
      "../../../../integrations/overlay-live-transit/manifest.json",
      import.meta.url,
    ),
    "overlay-natural-events": new URL(
      "../../../../integrations/overlay-natural-events/manifest.json",
      import.meta.url,
    ),
    "overlay-nautical": new URL(
      "../../../../integrations/overlay-nautical/manifest.json",
      import.meta.url,
    ),
    "overlay-ourairports": new URL(
      "../../../../integrations/overlay-ourairports/manifest.json",
      import.meta.url,
    ),
    "overlay-satellite": new URL(
      "../../../../integrations/overlay-satellite/manifest.json",
      import.meta.url,
    ),
    "overlay-schematic-transit": new URL(
      "../../../../integrations/overlay-schematic-transit/manifest.json",
      import.meta.url,
    ),
    "overlay-sun-time": new URL(
      "../../../../integrations/overlay-sun-time/manifest.json",
      import.meta.url,
    ),
    "overlay-tool-measurement": new URL(
      "../../../../integrations/overlay-tool-measurement/manifest.json",
      import.meta.url,
    ),
    "overlay-tool-travel-time": new URL(
      "../../../../integrations/overlay-tool-travel-time/manifest.json",
      import.meta.url,
    ),
    "overlay-traffic-flow": new URL(
      "../../../../integrations/overlay-traffic-flow/manifest.json",
      import.meta.url,
    ),
    "overlay-traffic-tomtom": new URL(
      "../../../../integrations/overlay-traffic-tomtom/manifest.json",
      import.meta.url,
    ),
    "overlay-transit": new URL(
      "../../../../integrations/overlay-transit/manifest.json",
      import.meta.url,
    ),
    "overlay-weather": new URL(
      "../../../../integrations/overlay-weather/manifest.json",
      import.meta.url,
    ),
    "overlay-weather-alerts": new URL(
      "../../../../integrations/overlay-weather-alerts/manifest.json",
      import.meta.url,
    ),
    "overlay-wildfires": new URL(
      "../../../../integrations/overlay-wildfires/manifest.json",
      import.meta.url,
    ),
    "overlay-winter-sports": new URL(
      "../../../../integrations/overlay-winter-sports/manifest.json",
      import.meta.url,
    ),
    parking: new URL("../../../../integrations/parking/manifest.json", import.meta.url),
    photos: new URL("../../../../integrations/photos/manifest.json", import.meta.url),
    "photos-flickr": new URL(
      "../../../../integrations/photos-flickr/manifest.json",
      import.meta.url,
    ),
    "photos-mapillary": new URL(
      "../../../../integrations/photos-mapillary/manifest.json",
      import.meta.url,
    ),
    "photos-panoramax": new URL(
      "../../../../integrations/photos-panoramax/manifest.json",
      import.meta.url,
    ),
    "photos-wikimedia": new URL(
      "../../../../integrations/photos-wikimedia/manifest.json",
      import.meta.url,
    ),
    "poi-overpass": new URL("../../../../integrations/poi-overpass/manifest.json", import.meta.url),
    "poi-overture": new URL("../../../../integrations/poi-overture/manifest.json", import.meta.url),
    "poi-search": new URL("../../../../integrations/poi-search/manifest.json", import.meta.url),
    restaurants: new URL("../../../../integrations/restaurants/manifest.json", import.meta.url),
    reviews: new URL("../../../../integrations/reviews/manifest.json", import.meta.url),
    "reviews-mangrove": new URL(
      "../../../../integrations/reviews-mangrove/manifest.json",
      import.meta.url,
    ),
    "ride-deeplink": new URL(
      "../../../../integrations/ride-deeplink/manifest.json",
      import.meta.url,
    ),
    "ride-gofs": new URL("../../../../integrations/ride-gofs/manifest.json", import.meta.url),
    "ride-hailing": new URL("../../../../integrations/ride-hailing/manifest.json", import.meta.url),
    "ride-partner": new URL("../../../../integrations/ride-partner/manifest.json", import.meta.url),
    "road-conditions": new URL(
      "../../../../integrations/road-conditions/manifest.json",
      import.meta.url,
    ),
    "road-maintenance": new URL(
      "../../../../integrations/road-maintenance/manifest.json",
      import.meta.url,
    ),
    "road-weather": new URL("../../../../integrations/road-weather/manifest.json", import.meta.url),
    routing: new URL("../../../../integrations/routing/manifest.json", import.meta.url),
    "routing-brouter": new URL(
      "../../../../integrations/routing-brouter/manifest.json",
      import.meta.url,
    ),
    "routing-osrm": new URL("../../../../integrations/routing-osrm/manifest.json", import.meta.url),
    "routing-valhalla": new URL(
      "../../../../integrations/routing-valhalla/manifest.json",
      import.meta.url,
    ),
    "scooter-sharing": new URL(
      "../../../../integrations/scooter-sharing/manifest.json",
      import.meta.url,
    ),
    "search-nlp": new URL("../../../../integrations/search-nlp/manifest.json", import.meta.url),
    "search-notable-places": new URL(
      "../../../../integrations/search-notable-places/manifest.json",
      import.meta.url,
    ),
    "search-osm-aliases": new URL(
      "../../../../integrations/search-osm-aliases/manifest.json",
      import.meta.url,
    ),
    "search-suggestions": new URL(
      "../../../../integrations/search-suggestions/manifest.json",
      import.meta.url,
    ),
    "street-level-imagery-mapillary": new URL(
      "../../../../integrations/street-level-imagery-mapillary/manifest.json",
      import.meta.url,
    ),
    "street-level-imagery-panoramax": new URL(
      "../../../../integrations/street-level-imagery-panoramax/manifest.json",
      import.meta.url,
    ),
    transit: new URL("../../../../integrations/transit/manifest.json", import.meta.url),
    "transit-db-vendo": new URL(
      "../../../../integrations/transit-db-vendo/manifest.json",
      import.meta.url,
    ),
    "transit-dynamic-registry": new URL(
      "../../../../integrations/transit-dynamic-registry/manifest.json",
      import.meta.url,
    ),
    "transit-entur": new URL(
      "../../../../integrations/transit-entur/manifest.json",
      import.meta.url,
    ),
    "transit-hafas": new URL(
      "../../../../integrations/transit-hafas/manifest.json",
      import.meta.url,
    ),
    "transit-irail": new URL(
      "../../../../integrations/transit-irail/manifest.json",
      import.meta.url,
    ),
    "transit-mbta": new URL("../../../../integrations/transit-mbta/manifest.json", import.meta.url),
    "transit-mobility-database": new URL(
      "../../../../integrations/transit-mobility-database/manifest.json",
      import.meta.url,
    ),
    "transit-motis": new URL(
      "../../../../integrations/transit-motis/manifest.json",
      import.meta.url,
    ),
    "transit-opentransportdata-ch": new URL(
      "../../../../integrations/transit-opentransportdata-ch/manifest.json",
      import.meta.url,
    ),
    "transit-otp": new URL("../../../../integrations/transit-otp/manifest.json", import.meta.url),
    "transit-overpass": new URL(
      "../../../../integrations/transit-overpass/manifest.json",
      import.meta.url,
    ),
    "transit-ris-routing": new URL(
      "../../../../integrations/transit-ris-routing/manifest.json",
      import.meta.url,
    ),
    "transit-tfl": new URL("../../../../integrations/transit-tfl/manifest.json", import.meta.url),
    "transit-transitland": new URL(
      "../../../../integrations/transit-transitland/manifest.json",
      import.meta.url,
    ),
    weather: new URL("../../../../integrations/weather/manifest.json", import.meta.url),
    "weather-bright-sky": new URL(
      "../../../../integrations/weather-bright-sky/manifest.json",
      import.meta.url,
    ),
    "weather-met-norway": new URL(
      "../../../../integrations/weather-met-norway/manifest.json",
      import.meta.url,
    ),
    "weather-open-meteo": new URL(
      "../../../../integrations/weather-open-meteo/manifest.json",
      import.meta.url,
    ),
    "weather-open-meteo-air-quality": new URL(
      "../../../../integrations/weather-open-meteo-air-quality/manifest.json",
      import.meta.url,
    ),
    "weather-openweathermap": new URL(
      "../../../../integrations/weather-openweathermap/manifest.json",
      import.meta.url,
    ),
    webcam: new URL("../../../../integrations/webcam/manifest.json", import.meta.url),
  });
}

function embeddedSource(urls: Record<string, URL>): BuiltInManifestSource {
  return {
    ids: Object.keys(urls).sort(),
    manifestPath(id) {
      if (!Object.hasOwn(urls, id)) throw new Error(`Unknown built-in manifest ${id}`);
      return fileURLToPath(urls[id] as URL);
    },
    embedded: true,
  };
}
