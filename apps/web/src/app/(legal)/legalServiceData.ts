export interface PrivacyServiceRow {
  service: string;
  purpose: string;
  dataSent: string;
  country: string;
  privacy: string;
  serviceId?: string | string[];
}

export interface AttributionRow {
  source: string;
  desc: string;
  license: string;
  licenseUrl?: string;
  url: string;
  serviceId?: string | string[];
}

export function filterByAvailability<T extends { serviceId?: string | string[] }>(
  rows: T[],
  capabilities: Record<string, boolean>,
): T[] {
  return rows.filter((row) => {
    if (!row.serviceId) return true;
    if (Array.isArray(row.serviceId)) {
      return row.serviceId.some((id) => capabilities[id] ?? true);
    }
    return capabilities[row.serviceId] ?? true;
  });
}

// 6.1 Map Tiles and Display
export const privacyMapTiles: PrivacyServiceRow[] = [
  {
    service: "MapTiler",
    purpose: "Base map tiles (streets, satellite, terrain), map styles",
    dataSent: "Map viewport coordinates, zoom level, API key",
    country: "Switzerland",
    privacy: "https://www.maptiler.com/privacy-policy/",
    serviceId: "maptiler",
  },
  {
    service: "OpenTopoMap",
    purpose: "Topographic map overlay",
    dataSent: "Tile coordinates (z/x/y)",
    country: "Germany",
    privacy: "https://opentopomap.org/about",
  },
  {
    service: "CyclOSM (OpenStreetMap France)",
    purpose: "Cycling-focused map tiles",
    dataSent: "Tile coordinates (z/x/y)",
    country: "France",
    privacy: "https://www.openstreetmap.fr/",
  },
  {
    service: "Thunderforest OpenCycleMap (fallback)",
    purpose: "Cycling-focused map tiles (fallback when CyclOSM is unavailable)",
    dataSent: "Tile coordinates (z/x/y)",
    country: "United Kingdom",
    privacy: "https://www.thunderforest.com/privacy/",
  },
  {
    service: "Waymarked Trails (tile overlay)",
    purpose: "Cycling route overlay tiles",
    dataSent: "Tile coordinates (z/x/y)",
    country: "Germany",
    privacy: "https://cycling.waymarkedtrails.org/",
  },
];

// 6.2 Geocoding and Search
export const privacyGeocoding: PrivacyServiceRow[] = [
  {
    service: "MapTiler Geocoding",
    purpose: "Address and place search",
    dataSent: "Search queries, bounding box, language",
    country: "Switzerland",
    privacy: "https://www.maptiler.com/privacy-policy/",
    serviceId: "maptiler",
  },
  {
    service: "Nominatim (OpenStreetMap Foundation)",
    purpose: "Address search, reverse geocoding, place enrichment",
    dataSent: "Search queries, coordinates, language",
    country: "UK / Various",
    privacy: "https://osmfoundation.org/wiki/Privacy_Policy",
  },
  {
    service: "Photon (Komoot)",
    purpose: "Address search (alternative provider)",
    dataSent: "Search queries, language",
    country: "Germany",
    privacy: "https://www.komoot.com/privacy",
  },
  {
    service: "Transitous / MOTIS Geocoding",
    purpose: "Transit stop and place search",
    dataSent: "Search queries, language",
    country: "Germany",
    privacy: "https://transitous.org/privacy/",
  },
];

// 6.3 Routing, Isochrones, and Elevation
export const privacyRouting: PrivacyServiceRow[] = [
  {
    service: "OSRM (public demo server)",
    purpose: "Car route calculation, route optimization",
    dataSent: "Waypoint coordinates, route options (avoid highways/tolls/ferries)",
    country: "Germany",
    privacy: "https://project-osrm.org/",
  },
  {
    service: "Valhalla (FOSSGIS e.V.)",
    purpose: "Walking, cycling, and driving routes; isochrone calculation; elevation profiles",
    dataSent:
      "Waypoint coordinates, routing mode, avoid options, isochrone parameters, elevation sample points",
    country: "Germany",
    privacy: "https://fossgis.de/datenschutzerkl%C3%A4rung/",
  },
];

// 6.4 Traffic Data
export const privacyTraffic: PrivacyServiceRow[] = [
  {
    service: "TomTom",
    purpose: "Live traffic flow overlay",
    dataSent: "Map tile coordinates, API key",
    country: "Netherlands",
    privacy: "https://www.tomtom.com/privacy/",
    serviceId: "tomtom-traffic",
  },
];

// 6.5 Street-Level Imagery
export const privacyStreetView: PrivacyServiceRow[] = [
  {
    service: "Mapillary (Meta Platforms)",
    purpose: "Street-level photos, panoramas, and coverage layer",
    dataSent: "Coordinates, bounding box, image IDs, access token",
    country: "USA",
    privacy: "https://www.mapillary.com/privacy",
    serviceId: "mapillary",
  },
  {
    service: "Panoramax (IGN France)",
    purpose: "Open street-level panorama imagery",
    dataSent: "Coordinates",
    country: "France",
    privacy: "https://panoramax.fr/",
  },
];

// 6.6 Place Photos
export const privacyPhotos: PrivacyServiceRow[] = [
  {
    service: "Flickr (SmugMug)",
    purpose: "CC-licensed place photos for photo galleries",
    dataSent: "Coordinates, search radius, API key",
    country: "USA",
    privacy: "https://www.flickr.com/help/privacy",
    serviceId: "flickr",
  },
  {
    service: "Wikimedia Commons (Wikimedia Foundation)",
    purpose: "Geo-tagged free-licensed photos for photo galleries",
    dataSent: "Coordinates, search radius",
    country: "USA",
    privacy: "https://foundation.wikimedia.org/wiki/Privacy_policy",
  },
];

// 6.7 Public Transit
export const privacyTransit: PrivacyServiceRow[] = [
  {
    service: "Transitous (MOTIS)",
    purpose: "Multimodal transit trip planning (global)",
    dataSent: "Start/end coordinates, date/time, modes",
    country: "Germany",
    privacy: "https://transitous.org/privacy/",
  },
  {
    service: "Deutsche Bahn RIS APIs (Stations, Routing, Maps, Transports)",
    purpose: "German rail station data, journey planning, route geometry, live train positions",
    dataSent: "Station queries, coordinates, date/time, journey IDs, API credentials (server-side)",
    country: "Germany",
    privacy: "https://www.bahn.de/datenschutz",
    serviceId: "db-ris",
  },
  {
    service: "TransitLand (Interline Technologies)",
    purpose: "Transit stops, routes, and departures",
    dataSent: "Bounding box, stop/route queries, API key (server-side)",
    country: "USA",
    privacy: "https://www.transit.land/terms",
    serviceId: "transitland",
  },
  {
    service: "Transport for London (TfL)",
    purpose: "London transit stops, routes, arrivals, and line statuses",
    dataSent: "Stop/line queries, coordinates, API key (server-side)",
    country: "UK",
    privacy: "https://tfl.gov.uk/corporate/privacy-and-cookies/",
    serviceId: "tfl",
  },
  {
    service: "MBTA (Massachusetts Bay Transportation Authority)",
    purpose: "Boston area transit stops, routes, and live departures",
    dataSent: "Stop/prediction queries, coordinates, API key (server-side)",
    country: "USA",
    privacy: "https://www.mbta.com/policies/privacy-policy",
    serviceId: "mbta",
  },
  {
    service: "iRail",
    purpose: "Belgian rail stops, connections, and departures",
    dataSent: "Station/connection queries",
    country: "Belgium",
    privacy: "https://docs.irail.be/",
  },
  {
    service: "transport.opendata.ch",
    purpose: "Swiss public transit stops, connections, and departures",
    dataSent: "Station/connection queries",
    country: "Switzerland",
    privacy: "https://transport.opendata.ch/",
  },
  {
    service: "Overpass API (OpenStreetMap)",
    purpose: "Transit stop data from OpenStreetMap (fallback)",
    dataSent: "Bounding box queries (Overpass QL)",
    country: "Germany",
    privacy: "https://wiki.openstreetmap.org/wiki/Overpass_API",
  },
  {
    service: "Dynamic transit providers (via public-transport/transport-apis registry)",
    purpose:
      "Additional regional transit APIs discovered at runtime from an open registry (~85 providers)",
    dataSent: "Station/journey queries (varies by provider)",
    country: "Various",
    privacy: "https://github.com/public-transport/transport-apis",
  },
];

// 6.8 Air Quality
export const privacyAirQuality: PrivacyServiceRow[] = [
  {
    service: "OpenAQ",
    purpose: "Air quality measurements (PM2.5, AQI)",
    dataSent: "Bounding box coordinates",
    country: "USA",
    privacy: "https://openaq.org/privacy/",
    serviceId: "openaq",
  },
];

// 6.9 Natural Disaster Data
export const privacyDisasters: PrivacyServiceRow[] = [
  {
    service: "NASA FIRMS (Fire Information for Resource Management System)",
    purpose: "Active wildfire/hotspot detections worldwide",
    dataSent: "Data source selection, time range, API key (server-side)",
    country: "USA",
    privacy: "https://www.nasa.gov/privacy/",
    serviceId: "firms-wildfires",
  },
  {
    service: "USGS Earthquake Hazards Program",
    purpose: "Earthquake locations, magnitudes, and depths",
    dataSent: "Time range, magnitude threshold (via pre-built URL; no user data sent)",
    country: "USA",
    privacy: "https://www.usgs.gov/privacy-policies",
  },
];

// 6.10 Hiking and Outdoor
export const privacyHiking: PrivacyServiceRow[] = [
  {
    service: "Waymarked Trails",
    purpose: "Hiking and cycling trail metadata (name, difficulty, length)",
    dataSent: "Search queries, bounding box",
    country: "Germany",
    privacy: "https://hiking.waymarkedtrails.org/",
  },
  {
    service: "Overpass API (OpenStreetMap)",
    purpose: "Hiking trails, winter sport areas, and other outdoor features from OpenStreetMap",
    dataSent: "Overpass QL queries with bounding box",
    country: "Germany",
    privacy: "https://wiki.openstreetmap.org/wiki/Overpass_API",
  },
  {
    service: "Refuges.info",
    purpose: "Mountain shelters and refuges (locations, altitude, capacity)",
    dataSent: "Bounding box coordinates",
    country: "France",
    privacy: "https://www.refuges.info/",
  },
];

// 6.11 EV Charging Stations
export const privacyEvCharging: PrivacyServiceRow[] = [
  {
    service: "OpenChargeMap",
    purpose: "EV charging station locations, connector types, and availability",
    dataSent: "Bounding box, filter parameters (connector type, usage type), API key",
    country: "UK",
    privacy: "https://community.openchargemap.org/privacy",
    serviceId: "openchargemap",
  },
];

// 6.12 Fuel Prices
export const privacyFuel: PrivacyServiceRow[] = [
  {
    service: "Tankerkoenig (MTS-K)",
    purpose: "German fuel station prices (E5, E10, Diesel)",
    dataSent: "Coordinates, search radius, API key",
    country: "Germany",
    privacy: "https://creativecommons.tankerkoenig.de/",
    serviceId: "tankerkoenig",
  },
  {
    service: "E-Control Spritpreisrechner",
    purpose: "Austrian fuel station prices",
    dataSent: "Address or coordinates",
    country: "Austria",
    privacy: "https://meine.e-control.org/privacy-policy/",
  },
  {
    service: "French government fuel price data",
    purpose: "French fuel station prices",
    dataSent: "Coordinates or region identifiers",
    country: "France",
    privacy: "https://www.prix-carburants.gouv.fr/rubrique/donnees-personnelles/",
  },
  {
    service: "Spanish government fuel price data",
    purpose: "Spanish fuel station prices",
    dataSent: "Coordinates or region identifiers",
    country: "Spain",
    privacy: "https://datos.gob.es/en/legal-notice",
  },
];

// 6.13 Parking
export const privacyParking: PrivacyServiceRow[] = [
  {
    service: "DB BahnPark (Deutsche Bahn)",
    purpose: "Parking facilities at German train stations (capacity, occupancy, pricing)",
    dataSent: "API credentials (server-side)",
    country: "Germany",
    privacy: "https://www.bahn.de/datenschutz",
    serviceId: "db-parking",
  },
  {
    service: "ParkAPI v2 (ParkenDD)",
    purpose: "Public parking lot availability in various European cities",
    dataSent: "City name query",
    country: "Germany",
    privacy: "https://parkendd.de/",
  },
  {
    service: "ParkAPI v3 (MobiData BW)",
    purpose: "Parking site data with occupancy (Baden-W\u00fcrttemberg and beyond)",
    dataSent: "Bounding box, filter parameters",
    country: "Germany",
    privacy: "https://www.mobidata-bw.de/pages/datenschutz",
  },
];

// 6.14 Shared Mobility (Bikes, Scooters, Car-Sharing)
export const privacySharedMobility: PrivacyServiceRow[] = [
  {
    service: "Deutsche Bahn GBFS (Call-a-Bike / StadtRad)",
    purpose: "DB bike-sharing station data",
    dataSent: "API credentials (server-side)",
    country: "Germany",
    privacy: "https://www.bahn.de/datenschutz",
    serviceId: "db-gbfs",
  },
  {
    service: "Citybikes API",
    purpose: "Global bike-sharing station data",
    dataSent: "Network/station queries",
    country: "Various",
    privacy: "https://citybik.es/",
  },
  {
    service: "Nextbike",
    purpose: "Bike-sharing locations",
    dataSent: "None (full dataset fetched)",
    country: "Germany",
    privacy: "https://www.nextbike.de/de/datenschutz/",
  },
  {
    service: "Cambio CarSharing",
    purpose: "Car-sharing station and vehicle availability",
    dataSent: "Coordinates",
    country: "Germany / Belgium",
    privacy: "https://www.cambio-carsharing.de/datenschutz",
  },
  {
    service: "Donkey Republic",
    purpose: "Bike-sharing station locations",
    dataSent: "Coordinates",
    country: "Denmark",
    privacy: "https://www.donkey.bike/privacy-policy/",
  },
  {
    service: "Felyx",
    purpose: "E-scooter/moped sharing locations",
    dataSent: "Bounding box",
    country: "Netherlands",
    privacy: "https://www.felyx.com/",
  },
  {
    service: "GO Sharing",
    purpose: "E-scooter and e-bike sharing locations",
    dataSent: "Bounding box",
    country: "Netherlands",
    privacy: "https://go-sharing.com/terms-conditions/",
  },
  {
    service: "Link (Superpedestrian)",
    purpose: "E-scooter sharing locations",
    dataSent: "Coordinates, company identifier",
    country: "USA",
    privacy: "https://www.linkyour.city/privacy-policy",
  },
  {
    service: "Stadtteilauto (M\u00fcnster) and regional providers",
    purpose: "Regional car-sharing stations and vehicle availability",
    dataSent: "None (full dataset fetched) or coordinates",
    country: "Germany",
    privacy: "See respective provider websites",
  },
  {
    service: "GBFS Catalog (MobilityData)",
    purpose: "Discovery of bike/scooter/car-sharing systems worldwide (~1,200 systems)",
    dataSent: "None (static catalog fetched server-side)",
    country: "Canada",
    privacy: "https://mobilitydata.org/privacy-policy/",
  },
  {
    service: "Transitous Rentals (MOTIS)",
    purpose: "Rental/sharing vehicle locations via MOTIS provider",
    dataSent: "Coordinates",
    country: "Germany",
    privacy: "https://transitous.org/privacy/",
  },
];

// Attribution data for Terms of Service

export const attributionMapData: AttributionRow[] = [
  {
    source: "OpenStreetMap",
    desc: "Map data \u00a9 OpenStreetMap contributors",
    license: "ODbL",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/",
    url: "https://www.openstreetmap.org/",
  },
  {
    source: "MapTiler",
    desc: "Map tiles, styles, and geocoding",
    license: "Proprietary",
    url: "https://www.maptiler.com/",
    serviceId: "maptiler",
  },
  {
    source: "OpenTopoMap",
    desc: "Topographic map tiles (OSM + SRTM data)",
    license: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
    url: "https://opentopomap.org/",
  },
  {
    source: "CyclOSM",
    desc: "Cycling-focused map tiles",
    license: "ODbL (OSM data)",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/",
    url: "https://www.cyclosm.org/",
  },
  {
    source: "Thunderforest OpenCycleMap",
    desc: "Cycling-focused map tiles (fallback)",
    license: "CC BY-SA 2.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/2.0/",
    url: "https://www.thunderforest.com/maps/opencyclemap/",
  },
  {
    source: "Nominatim",
    desc: "Geocoding and reverse geocoding",
    license: "ODbL (OSM data)",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/",
    url: "https://nominatim.openstreetmap.org/",
  },
  {
    source: "Photon (Komoot)",
    desc: "Alternative geocoder",
    license: "ODbL (OSM data)",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/",
    url: "https://photon.komoot.io/",
  },
  {
    source: "Overpass API",
    desc: "OSM data queries for POIs, trails, transit stops",
    license: "ODbL (OSM data)",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/",
    url: "https://overpass-api.de/",
  },
];

export const attributionRouting: AttributionRow[] = [
  {
    source: "OSRM",
    desc: "Car route calculation and optimization",
    license: "BSD 2-Clause",
    licenseUrl: "https://github.com/Project-OSRM/osrm-backend/blob/master/LICENSE.TXT",
    url: "https://project-osrm.org/",
  },
  {
    source: "Valhalla (FOSSGIS e.V.)",
    desc: "Walking, cycling, driving routes; isochrones; elevation profiles",
    license: "MIT",
    licenseUrl: "https://github.com/valhalla/valhalla/blob/master/LICENSE.md",
    url: "https://fossgis.de/",
  },
];

export const attributionStreetView: AttributionRow[] = [
  {
    source: "Mapillary",
    desc: "Street-level photos and panoramas \u00a9 Mapillary contributors",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    url: "https://www.mapillary.com/",
    serviceId: "mapillary",
  },
  {
    source: "Panoramax (IGN France)",
    desc: "Open street-level panoramas",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    url: "https://panoramax.fr/",
  },
];

export const attributionPhotos: AttributionRow[] = [
  {
    source: "Flickr (SmugMug)",
    desc: "CC-licensed place photos (only CC images displayed)",
    license: "Various CC",
    licenseUrl: "https://creativecommons.org/licenses/",
    url: "https://www.flickr.com/",
    serviceId: "flickr",
  },
  {
    source: "Wikimedia Commons",
    desc: "Geo-tagged free-licensed images",
    license: "Various free licenses",
    url: "https://commons.wikimedia.org/",
  },
];

export const attributionTraffic: AttributionRow[] = [
  {
    source: "TomTom",
    desc: "Traffic flow data \u00a9 TomTom International BV",
    license: "Proprietary",
    url: "https://www.tomtom.com/",
    serviceId: "tomtom-traffic",
  },
];

export const attributionTransit: AttributionRow[] = [
  {
    source: "Transitous (MOTIS)",
    desc: "Open multimodal transit routing",
    license: "MIT",
    licenseUrl: "https://github.com/motis-project/motis/blob/master/LICENSE",
    url: "https://transitous.org/",
  },
  {
    source: "Deutsche Bahn RIS",
    desc: "Rail data \u00a9 DB InfraGO AG / DB Fernverkehr AG",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    url: "https://developers.deutschebahn.com/",
    serviceId: "db-ris",
  },
  {
    source: "TransitLand",
    desc: "Transit data aggregation by Interline Technologies",
    license: "Various per feed",
    url: "https://www.transit.land/",
    serviceId: "transitland",
  },
  {
    source: "TfL",
    desc: "Powered by TfL Open Data; contains OS data \u00a9 Crown copyright",
    license: "OGL v3.0",
    licenseUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    url: "https://tfl.gov.uk/",
    serviceId: "tfl",
  },
  {
    source: "MBTA",
    desc: "Massachusetts Bay Transportation Authority",
    license: "MassDOT Open Data",
    url: "https://www.mbta.com/",
    serviceId: "mbta",
  },
  {
    source: "iRail",
    desc: "Belgian rail data (Open Knowledge Belgium)",
    license: "Open data",
    url: "https://docs.irail.be/",
  },
  {
    source: "transport.opendata.ch",
    desc: "Swiss public transport data",
    license: "Open data",
    url: "https://transport.opendata.ch/",
  },
  {
    source: "Dynamic transit providers",
    desc: "~85 regional APIs via open registry",
    license: "Various per provider",
    url: "https://github.com/public-transport/transport-apis",
  },
];

export const attributionAirQualityDisasters: AttributionRow[] = [
  {
    source: "OpenAQ",
    desc: "Air quality measurements from government networks worldwide",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    url: "https://openaq.org/",
    serviceId: "openaq",
  },
  {
    source: "NASA FIRMS",
    desc: "Wildfire/hotspot detections (VIIRS, MODIS)",
    license: "Public domain (US Gov)",
    url: "https://firms.modaps.eosdis.nasa.gov/",
    serviceId: "firms-wildfires",
  },
  {
    source: "USGS",
    desc: "Earthquake locations, magnitudes, and depths",
    license: "Public domain (US Gov)",
    url: "https://earthquake.usgs.gov/",
  },
];

export const attributionHiking: AttributionRow[] = [
  {
    source: "Waymarked Trails",
    desc: "Hiking and cycling trail data and overlay tiles",
    license: "ODbL (OSM data)",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/",
    url: "https://waymarkedtrails.org/",
  },
  {
    source: "Refuges.info",
    desc: "Mountain shelters and refuges (community database)",
    license: "CC BY-SA 2.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/2.0/",
    url: "https://www.refuges.info/",
  },
];

export const attributionEvFuelParking: AttributionRow[] = [
  {
    source: "OpenChargeMap",
    desc: "EV charging station locations and details",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    url: "https://openchargemap.org/",
    serviceId: "openchargemap",
  },
  {
    source: "Tankerkoenig (MTS-K)",
    desc: "German fuel station prices",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    url: "https://creativecommons.tankerkoenig.de/",
    serviceId: "tankerkoenig",
  },
  {
    source: "E-Control",
    desc: "Austrian fuel prices",
    license: "Public data",
    url: "https://www.e-control.at/",
  },
  {
    source: "French government",
    desc: "French fuel prices",
    license: "Licence Ouverte v2.0",
    licenseUrl: "https://github.com/etalab/licence-ouverte/blob/master/LO.md",
    url: "https://www.prix-carburants.gouv.fr/",
  },
  {
    source: "Spanish government",
    desc: "Spanish fuel prices",
    license: "Government open data",
    url: "https://datos.gob.es/",
  },
  {
    source: "DB BahnPark",
    desc: "Parking at German train stations",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    url: "https://www.dbbahnpark.de/",
    serviceId: "db-parking",
  },
  {
    source: "ParkAPI / ParkenDD",
    desc: "Public parking lot availability",
    license: "Various",
    url: "https://parkendd.de/",
  },
  {
    source: "MobiData BW",
    desc: "Parking data (Baden-W\u00fcrttemberg)",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    url: "https://mobidata-bw.de/",
  },
];

export const attributionSharedMobility: AttributionRow[] = [
  {
    source: "Deutsche Bahn GBFS",
    desc: "Call-a-Bike / StadtRad",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    url: "https://data.deutschebahn.com/",
    serviceId: "db-gbfs",
  },
  {
    source: "Citybikes API",
    desc: "Global bike-sharing data",
    license: "Custom ToS",
    url: "https://citybik.es/",
  },
  {
    source: "Nextbike",
    desc: "Bike-sharing locations",
    license: "Proprietary",
    url: "https://www.nextbike.net/",
  },
  {
    source: "Cambio CarSharing",
    desc: "Car-sharing availability",
    license: "ODbL",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/",
    url: "https://www.cambio-carsharing.de/",
  },
  {
    source: "Donkey Republic",
    desc: "Bike-sharing stations",
    license: "Proprietary",
    url: "https://www.donkey.bike/",
  },
  {
    source: "Felyx",
    desc: "E-moped sharing",
    license: "Proprietary",
    url: "https://www.felyx.com/",
  },
  {
    source: "GO Sharing",
    desc: "E-scooter and e-bike sharing",
    license: "Proprietary",
    url: "https://go-sharing.com/",
  },
  {
    source: "Link (Superpedestrian)",
    desc: "E-scooter sharing",
    license: "Proprietary",
    url: "https://www.linkyour.city/",
  },
  {
    source: "Stadtteilauto (M\u00fcnster)",
    desc: "Regional car-sharing",
    license: "dl-de/by-2-0",
    licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
    url: "https://www.stadtteilauto.com/",
  },
  {
    source: "GBFS Catalog (MobilityData)",
    desc: "Shared mobility system discovery",
    license: "MobilityData License",
    url: "https://mobilitydata.org/",
  },
];

// Section label maps

export const privacySectionLabels = {
  en: {
    mapTiles: "6.1 Map Tiles and Display",
    geocoding: "6.2 Geocoding and Search",
    routing: "6.3 Routing, Isochrones, and Elevation",
    traffic: "6.4 Traffic Data",
    streetView: "6.5 Street-Level Imagery",
    photos: "6.6 Place Photos",
    transit: "6.7 Public Transit",
    airQuality: "6.8 Air Quality",
    disasters: "6.9 Natural Disaster Data",
    hiking: "6.10 Hiking and Outdoor",
    evCharging: "6.11 EV Charging Stations",
    fuel: "6.12 Fuel Prices",
    parking: "6.13 Parking",
    sharedMobility: "6.14 Shared Mobility",
  },
  de: {
    mapTiles: "6.1 Kartenkacheln und Darstellung",
    geocoding: "6.2 Geokodierung und Suche",
    routing: "6.3 Routing, Isochronen und H\u00f6henprofil",
    traffic: "6.4 Verkehrsdaten",
    streetView: "6.5 Stra\u00dfenansicht",
    photos: "6.6 Ortsfotos",
    transit: "6.7 \u00d6ffentlicher Nahverkehr",
    airQuality: "6.8 Luftqualit\u00e4t",
    disasters: "6.9 Naturkatastrophen-Daten",
    hiking: "6.10 Wandern und Outdoor",
    evCharging: "6.11 E-Ladestationen",
    fuel: "6.12 Kraftstoffpreise",
    parking: "6.13 Parken",
    sharedMobility: "6.14 Shared Mobility",
  },
} as const;

export type PrivacySectionKey = keyof typeof privacySectionLabels.en;

// Helper: get filtered privacy sections

export function getPrivacySections(capabilities: Record<string, boolean>) {
  const sections: { key: PrivacySectionKey; rows: PrivacyServiceRow[] }[] = [
    { key: "mapTiles", rows: privacyMapTiles },
    { key: "geocoding", rows: privacyGeocoding },
    { key: "routing", rows: privacyRouting },
    { key: "traffic", rows: privacyTraffic },
    { key: "streetView", rows: privacyStreetView },
    { key: "photos", rows: privacyPhotos },
    { key: "transit", rows: privacyTransit },
    { key: "airQuality", rows: privacyAirQuality },
    { key: "disasters", rows: privacyDisasters },
    { key: "hiking", rows: privacyHiking },
    { key: "evCharging", rows: privacyEvCharging },
    { key: "fuel", rows: privacyFuel },
    { key: "parking", rows: privacyParking },
    { key: "sharedMobility", rows: privacySharedMobility },
  ];
  return sections
    .map((s) => ({ ...s, rows: filterByAvailability(s.rows, capabilities) }))
    .filter((s) => s.rows.length > 0);
}

// Helper: get filtered attribution sections

export function getAttributionSections(capabilities: Record<string, boolean>) {
  const sections: {
    heading: string;
    headingDe: string;
    rows: AttributionRow[];
  }[] = [
    {
      heading: "Map Data and Geocoding",
      headingDe: "Kartendaten und Geokodierung",
      rows: attributionMapData,
    },
    {
      heading: "Routing",
      headingDe: "Routing",
      rows: attributionRouting,
    },
    {
      heading: "Street-Level Imagery",
      headingDe: "Stra\u00dfenansicht",
      rows: attributionStreetView,
    },
    {
      heading: "Place Photos",
      headingDe: "Ortsfotos",
      rows: attributionPhotos,
    },
    {
      heading: "Traffic",
      headingDe: "Verkehr",
      rows: attributionTraffic,
    },
    {
      heading: "Public Transit",
      headingDe: "\u00d6ffentlicher Nahverkehr",
      rows: attributionTransit,
    },
    {
      heading: "Air Quality and Natural Disasters",
      headingDe: "Luftqualit\u00e4t und Naturkatastrophen",
      rows: attributionAirQualityDisasters,
    },
    {
      heading: "Hiking and Outdoor",
      headingDe: "Wandern und Outdoor",
      rows: attributionHiking,
    },
    {
      heading: "EV Charging, Fuel Prices, and Parking",
      headingDe: "E-Ladestationen, Kraftstoffpreise und Parken",
      rows: attributionEvFuelParking,
    },
    {
      heading: "Shared Mobility",
      headingDe: "Shared Mobility",
      rows: attributionSharedMobility,
    },
  ];
  return sections
    .map((s) => ({ ...s, rows: filterByAvailability(s.rows, capabilities) }))
    .filter((s) => s.rows.length > 0);
}
