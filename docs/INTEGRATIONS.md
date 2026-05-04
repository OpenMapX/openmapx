# Integrations

## bike-sharing

### CityBikes API — `https://api.citybik.es/v2/networks`
- Data sent: Network index with fields filter; then per-network station data by network href. No user location data sent
- Data received: Network index (~900 networks with location), then per-network stations with available bikes, empty slots, coordinates
- Purpose: Show bike-sharing stations from aggregated global networks
- License: Proprietary (custom terms, attribution required)
- URL: https://docs.citybik.es/api/tos
- Commercial use: Not explicitly addressed; no prohibition but no explicit permission either
- Usage limits: None specified
- Attribution: Yes — link to the CityBikes project page
- Other: Data is scraped from various operators; underlying operator terms may also apply
- Privacy: -
- Country: Spain (personal project by Lluís Esquerda, Barcelona; no formal legal entity)
- Privacy other: No privacy policy published; API serves aggregated station data with no personal data
- End-user data exposure: Server-only — requests are made by the API server; end-user IP is not exposed to CityBikes
- DPA: Not available (personal project, no legal entity)
- Coverage: Global (~900 networks worldwide)
- Env vars: None
- Self-hostable: Yes — open-source PyBikes library (<https://github.com/eskerda/pybikes>)

### Donkey Republic API — `https://stables.donkey.bike/api/public/nearby`
- Data sent: Bounding box coordinates (top-right and bottom-left corner lat/lng pairs)
- Data received: Hubs with available bikes/e-bikes/e-scooters counts, coordinates, radius
- Purpose: Show Donkey Republic multi-vehicle hubs in European cities
- License: Proprietary
- URL: https://www.donkey.bike/terms-and-conditions/
- Commercial use: Unknown — terms cover rider service only, no API/data terms published
- Usage limits: Unknown
- Attribution: Unknown
- Privacy: https://www.donkey.bike/privacy-policy
- Country: Denmark (DonkeyRepublic Admin ApS, Copenhagen)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Europe (multiple cities)
- Env vars: None
- Self-hostable: No

### Nextbike API — `https://maps.nextbike.net/maps/nextbike-live.json`
- Data sent: No user data (fetches entire global dataset)
- Data received: All countries > cities > stations with uid, name, lat/lng, available bikes, free racks
- Purpose: Show Nextbike bike-sharing stations; filtered to viewport client-side
- License: Proprietary
- URL: https://github.com/nextbike/api-doc
- Commercial use: Unknown — no public license or API terms
- Usage limits: Requests at intervals < 10 min are blocked
- Attribution: Not specified
- Privacy: https://www.nextbike.de/en/privacy/
- Country: Germany (nextbike GmbH, Leipzig)
- Privacy other: GBFS/API feeds explicitly contain no personal information per nextbike
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global (300+ cities, 30+ countries)
- Env vars: None
- Self-hostable: No

### Deutsche Bahn GBFS — `https://apis.deutschebahn.com/db-api-marketplace/apis/shared-mobility-gbfs/v2/de/{providerId}/{endpoint}`
- Data sent: Provider ID (4 providers: CallABike, StadtRadHamburg, RegioRadStuttgart, StadtRADLueneburg). No user location data sent; fetches full GBFS feeds per provider
- Data received: GBFS v2.3: station locations/capacity, bike availability counts, free-floating vehicle positions, vehicle types
- Purpose: Show Call-a-Bike and StadtRad stations and free-floating bikes in German cities
- License: Proprietary (custom bilateral license per API product)
- URL: https://developers.deutschebahn.com/db-api-marketplace/apis/nutzungsbedingungen
- Commercial use: Yes, but requires individual license agreement per API product
- Usage limits: DB may limit API calls for technical/security reasons; caps set per product
- Attribution: Per individual API product license
- Other: Content must be treated as confidential; DB may discontinue APIs at any time
- Privacy: https://developers.deutschebahn.com/db-api-marketplace/apis/privacypolicy
- Country: Germany (Deutsche Bahn AG, Frankfurt am Main)
- Privacy other: Developer-specific privacy notice; IP/browser data auto-deleted after 28 days; DPO: konzerndatenschutz@deutschebahn.com
- End-user data exposure: Server-only
- DPA: Not available (enterprise arrangements may be possible; contact Deutsche Bahn)
- Coverage: Germany
- Env vars: `DB_GBFS_CLIENT_ID`, `DB_GBFS_API_KEY` — optional pair; other providers still work without
- Self-hostable: No

## car-sharing

### Cambio API — `https://cwapi.cambio-carsharing.com/pub/{region}/stations`
- Data sent: Region code in URL path (matched by proximity to viewport center, up to 14 regions). No user location data sent directly
- Data received: Stations with name, coordinates, address, vehicle count, vehicle classes
- Purpose: Show Cambio station-based car-sharing in Germany and Belgium
- License: Datenlizenz Deutschland Zero 2.0
- URL: https://www.govdata.de/dl-de/zero-2-0
- Commercial use: Yes, unrestricted
- Usage limits: None
- Attribution: Not required (public domain equivalent)
- Privacy: https://www.cambio-carsharing.de/en/privacy-policy/privacy-policy-for-the-cambio-website
- Country: Germany (cambio Mobilitätsservice GmbH & Co. KG, Bremen)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Germany + Belgium (14 regions within ~50km of viewport)
- Env vars: None
- Self-hostable: No

### Stadtteilauto Münster — `https://www.muenster01.de/stadtteilauto/stations.json`
- Data sent: No user data (static dataset, fetches all stations)
- Data received: Stations with name, coordinates, address, vehicle count, station type (fixed/free-floating)
- Purpose: Show car-sharing stations in Münster (open data)
- License: Datenlizenz Deutschland Namensnennung 2.0 (portal default)
- URL: https://opendata.stadt-muenster.de/dataset/stadtteilauto-m%C3%BCnster-carsharing-stationen-und-fahrzeuge
- Commercial use: Yes
- Usage limits: None specified
- Attribution: Yes — "Datenquelle: Stadt Münster"
- Privacy: https://www.stadt-muenster.de/datenschutz
- Country: Germany (Stadt Münster)
- End-user data exposure: Server-only
- DPA: Not applicable (German public authority, open data)
- Coverage: Münster, Germany
- Env vars: None
- Self-hostable: No

### Stadtteilauto Münster Vehicles — `https://www.muenster01.de/stadtteilauto/vehicles.json`
- Data sent: No user data (static dataset, fetched in parallel with stations)
- Data received: Vehicles with available stations, price class, equipment details
- Purpose: Enrich station data with vehicle class and pricing info
- License: Datenlizenz Deutschland Namensnennung 2.0 (portal default)
- URL: https://opendata.stadt-muenster.de/dataset/stadtteilauto-m%C3%BCnster-carsharing-stationen-und-fahrzeuge
- Commercial use: Yes
- Usage limits: None specified
- Attribution: Yes — "Datenquelle: Stadt Münster"
- Privacy: https://www.stadt-muenster.de/datenschutz
- Country: Germany (Stadt Münster)
- End-user data exposure: Server-only
- DPA: Not applicable (German public authority, open data)
- Coverage: Münster, Germany
- Env vars: None
- Self-hostable: No

### Bielefeld WFS — `https://www.bielefeld01.de/md/WFS/carsharing/01?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&...`
- Data sent: No user data (static WFS query with fixed parameters for carsharing layer)
- Data received: CSV with WKT point geometries, station name, address, capacity, booking website URL
- Purpose: Show Cambio car-sharing stations in Bielefeld (open data)
- License: CC BY 4.0
- URL: https://open-data.bielefeld.de/page/nutzungsbedingungen
- Commercial use: Yes
- Usage limits: None specified
- Attribution: Yes — "Datenquelle: Stadt Bielefeld – open-data.bielefeld.de"
- Privacy: https://www.bielefeld.de/datenschutzerklaerung
- Country: Germany (Stadt Bielefeld)
- End-user data exposure: Server-only
- DPA: Not applicable (German public authority, open data)
- Coverage: Bielefeld, Germany
- Env vars: None
- Self-hostable: No

### Wuppertal Open Data — `https://daten.wuppertal.de/Transport_Verkehr/Carsharing_EPSG4326_JSON.json`
- Data sent: No user data (static dataset, fetches all stations)
- Data received: GeoJSON with station name, address, coordinates, vehicle count, provider name, vehicle classes
- Purpose: Show car-sharing stations from multiple operators in Wuppertal (open data)
- License: CC BY 4.0
- URL: https://offenedaten-wuppertal.de/page/nutzungsbedingungen-kontakt-lizenzen
- Commercial use: Yes
- Usage limits: None specified
- Attribution: Yes — "Datenquelle: CC-BY-4.0 - Stadt Wuppertal - offenedaten-wuppertal.de"
- Privacy: https://www.wuppertal.de/service/datenschutz_dsgvo.php
- Country: Germany (Stadt Wuppertal)
- End-user data exposure: Server-only
- DPA: Not applicable (German public authority, open data)
- Coverage: Wuppertal, Germany
- Env vars: None
- Self-hostable: No

## enrichment-sunrise-sunset

### Sunrise-Sunset API — `https://api.sunrise-sunset.org/json`
- Data sent: Coordinates (latitude, longitude rounded to 4 decimal places), date, timezone ID (auto-detected from coordinates)
- Data received: Sunrise, sunset, solar noon, day length, civil/nautical/astronomical twilight begin/end times (ISO 8601)
- Purpose: Show sunrise/sunset and twilight times on place detail panel. Cached 6h.
- License: Proprietary (free to use with attribution)
- URL: https://sunrise-sunset.org/terms
- Commercial use: Ambiguous — site terms say "personal use only" but API page does not explicitly prohibit commercial use
- Usage limits: No specific caps; must not exceed "reasonable request volume"
- Attribution: Yes — link to sunrise-sunset.org
- Privacy: https://sunrise-sunset.org/privacy
- Country: Unknown (operator identity not disclosed; WHOIS privacy; no company, address, or country revealed)
- Privacy other: No legal entity or jurisdiction disclosed — GDPR concern for EU users; third-party ads served via Freestar
- End-user data exposure: Server-only
- DPA: Not available (unknown entity, no legal presence)
- Coverage: Global
- Env vars: None
- Self-hostable: Yes — replace with `suncalc` npm library for pure-math calculation (<https://github.com/mourner/suncalc>)

## enrichment-wikidata

### Wikidata API — `https://www.wikidata.org/w/api.php`
- Data sent: Wikidata entity ID (QID from OSM tag), language preference. Second call sends referenced entity IDs for label resolution
- Data received: Entity claims, descriptions, Wikipedia sitelinks; then second call to resolve referenced QIDs to human-readable labels
- Purpose: Enrich place details with structured facts (founding date, population, architect, etc.), description, Wikipedia link, and lead image
- License: CC0 1.0 (structured data)
- URL: https://www.wikidata.org/wiki/Wikidata:Licensing
- Commercial use: Yes, unrestricted
- Usage limits: None by license; Wikimedia API usage policy applies separately
- Attribution: Not required (CC0)
- Privacy: https://foundation.wikimedia.org/wiki/Policy:Privacy_policy
- Country: US (Wikimedia Foundation, Inc., San Francisco, CA)
- Privacy other: IP addresses collected for all API requests; personal info deleted/de-identified after 90 days; servers in US
- End-user data exposure: Server-only
- DPA: Not available (Wikimedia Foundation acts as independent controller)
- Coverage: Global
- Env vars: None
- Self-hostable: Yes — qEndpoint Docker image, but needs ~16 GB RAM for full Wikidata (<https://hub.docker.com/r/qacompany/qendpoint-wikidata>)

## enrichment-wikimedia-commons

### Wikimedia Commons API — `https://commons.wikimedia.org/w/api.php`
- License: Per-file (most CC BY-SA 4.0, CC BY 4.0, or Public Domain)
- URL: https://commons.wikimedia.org/wiki/Commons:Licensing
- Commercial use: Yes — Commons policy requires all hosted files to allow commercial use
- Usage limits: Wikimedia API usage policy applies
- Attribution: Per individual file license; check each file's description page
- Other: Non-commercial content (CC BY-NC) is not allowed on Commons
- Data sent: Wikimedia Commons filename or category name (from OSM `wikimedia_commons` tag)
- Data received: File pages with thumbnail URL (800px), artist, license short name/URL, capture date, coordinates. Up to 6 files per category.
- Purpose: Show photos from a place's Wikimedia Commons category with proper attribution. Only called when OSM feature has `wikimedia_commons` tag.
- Privacy: https://foundation.wikimedia.org/wiki/Policy:Privacy_policy
- Country: US (Wikimedia Foundation)
- End-user data exposure: Server-only
- DPA: Not available (Wikimedia Foundation acts as independent controller)
- Coverage: Global
- Env vars: None
- Self-hostable: Partially — MediaWiki is self-hostable but full media archive is impractical (~100M+ files)

## enrichment-wikipedia

### Wikipedia REST API — `https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}`
- Data sent: Article title and language code (extracted from OSM `wikipedia` tag)
- Data received: Article description, thumbnail/original image URL, desktop page URL
- Purpose: Show Wikipedia description and lead image on place detail panel
- License: CC BY-SA 4.0 / GFDL (dual-licensed text content)
- URL: https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use
- Commercial use: Yes, as long as license terms (share-alike) are followed
- Usage limits: Wikimedia API usage policy applies
- Attribution: Yes — hyperlink/URL to the article (preferred), or list of all authors
- Privacy: https://foundation.wikimedia.org/wiki/Policy:Privacy_policy
- Country: US (Wikimedia Foundation)
- End-user data exposure: Server-only
- DPA: Not available (Wikimedia Foundation acts as independent controller)
- Coverage: Global (multi-language)
- Env vars: None
- Self-hostable: Partially — MediaWiki self-hostable; Wikipedia database dumps available at dumps.wikimedia.org

### Wikimedia Commons API — `https://commons.wikimedia.org/w/api.php`
- Data sent: Image filename (extracted from Wikipedia article thumbnail URL)
- Data received: Image metadata: artist, license short name/URL, thumbnail URL, capture date, coordinates
- Purpose: Get proper attribution and licensing for the Wikipedia article's lead image
- License: Per-file (most CC BY-SA 4.0, CC BY 4.0, or Public Domain)
- URL: https://commons.wikimedia.org/wiki/Commons:Licensing
- Commercial use: Yes
- Attribution: Per individual file license
- Privacy: https://foundation.wikimedia.org/wiki/Policy:Privacy_policy
- Country: US (Wikimedia Foundation)
- End-user data exposure: Server-only
- DPA: Not available (Wikimedia Foundation acts as independent controller)
- Coverage: Global
- Env vars: None
- Self-hostable: Partially

## ev-charging

### OpenChargeMap POI API — `https://api.openchargemap.io/v3/poi/`
- Data sent: Bounding box coordinates (south, west, north, east), optional filters (connector type, usage type, status)
- Data received: Charging stations with connector types/power levels, operator info, usage cost, availability status, coordinates
- Purpose: Show EV charging stations with connector details, power, and availability
- License: CC BY 4.0 (user-contributed data; third-party imports may differ)
- URL: https://openchargemap.org/site/about/terms
- Commercial use: Yes
- Usage limits: API key required; rate restrictions on requests with maxresults > 250
- Attribution: Yes — data provider credits and license terms must be visible to end user
- Other: Use `opendata=true` parameter to filter to CC BY 4.0 data only
- Privacy: https://www.openchargemap.org/about/terms
- Country: Australia (Webprofusion Pty Ltd, City Beach WA)
- Privacy other: No explicit GDPR statement; user contributions publicly attributable to OCM user account
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: `OPENCHARGEMAP_API_KEY` — required
- Self-hostable: Yes — open-source OCM system (<https://github.com/openchargemap/ocm-system>)

### OpenChargeMap Reference Data — `https://api.openchargemap.io/v3/referencedata/`
- Data sent: No user data (static reference dataset)
- Data received: Reference lists: connector types, status types, usage types, operators, charger types, current types
- Purpose: Populate filter dropdown options for the EV charging data source. Cached 48h.
- License: CC BY 4.0 (user-contributed data; third-party imports may differ)
- URL: https://openchargemap.org/site/about/terms
- Commercial use: Yes
- Usage limits: API key required
- Attribution: Yes — data provider credits visible to end user
- Privacy: https://www.openchargemap.org/about/terms
- Country: Australia (Webprofusion Pty Ltd)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: `OPENCHARGEMAP_API_KEY` — required
- Self-hostable: Yes (same as above)

## fuel

### Tankerkoenig API (Germany) — `https://creativecommons.tankerkoenig.de/json/list.php`
- Data sent: Center coordinates (latitude, longitude), search radius (max 25 km)
- Data received: Gas stations with name, brand, address, coordinates, live diesel/E5/E10 prices (EUR), open/closed status
- Purpose: Show German gas stations with live fuel prices
- License: CC BY 4.0
- URL: https://creativecommons.tankerkoenig.de/
- Commercial use: Yes — but mineral oil companies/gas stations are explicitly prohibited
- Usage limits: Max 1 req/5 min (home automation); max 10 station IDs per batch; max 25 km radius
- Attribution: Yes — link to www.tankerkoenig.de; mobile apps must include in app store description
- Other: API keys must not be shared publicly; excessive load leads to key suspension
- Privacy: https://onboarding.tankerkoenig.de/datenschutz
- Country: Germany (Tankerkoenig UG, Nesselwang, Bavaria)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Germany (bbox 47.0-55.5N, 5.5-15.5E)
- Env vars: `TANKERKOENIG_API_KEY` — optional; Germany provider skipped if unset
- Self-hostable: No

### Ministerio para la Transicion Ecologica (Spain) — `https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/`
- Data sent: No user data (fetches entire national dataset)
- Data received: All Spanish gas stations with name, address, coordinates, prices for 5 fuel types (comma-decimal format)
- Purpose: Show Spanish gas stations with fuel prices; filtered to viewport client-side
- License: Proprietary (Spanish public sector reuse terms, Ley 37/2007)
- URL: https://sede.serviciosmin.gob.es/es-ES/Paginas/aviso.aspx#Reutilizacion
- Commercial use: Generally permitted under EU PSI Directive transposition
- Usage limits: None formal; ministry reserves right to block abusive/automated use
- Attribution: Yes — must cite source and date of last update
- Privacy: https://sede.serviciosmin.gob.es/es-es/paginas/proteccion-datos-personales.aspx
- Country: Spain (Ministerio de Industria y Turismo, Madrid)
- End-user data exposure: Server-only
- DPA: Not applicable (Spanish government)
- Coverage: Spain (incl. Canary Islands; bbox 27.6-43.8N, -18.2-4.4E)
- Env vars: None
- Self-hostable: No

### French Government Open Data (France) — `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records`
- Data sent: Center coordinates (latitude, longitude), search radius
- Data received: Gas stations with address, city, coordinates, prices for 6 fuel types (Diesel, SP95, E10, SP98, E85, GPLc) with update timestamps
- Purpose: Show French gas stations with live fuel prices
- License: Licence Ouverte v2.0 (Etalab)
- URL: https://www.etalab.gouv.fr/wp-content/uploads/2017/04/ETALAB-Licence-Ouverte-v2.0.pdf
- Commercial use: Yes, unrestricted
- Usage limits: None
- Attribution: Yes — name of data provider, date, and "Licence Ouverte Version 2.0"
- Privacy: https://data.economie.gouv.fr/terms/privacy-policy/
- Country: France (Ministères Économiques et Financiers, Paris)
- Privacy other: Platform operated by OpenDataSoft as sub-processor; anonymous API access requires no account
- End-user data exposure: Server-only
- DPA: Not applicable (French government)
- Coverage: France (bbox 41.3-51.1N, -5.2-9.6E)
- Env vars: None
- Self-hostable: No

### E-Control Spritpreisrechner (Austria) — `https://api.e-control.at/sprit/1.0/search/gas-stations/by-address`
- Data sent: Center coordinates (latitude, longitude), search radius, fuel type (diesel and Super 95 queried separately)
- Data received: Gas stations with name, address, coordinates, prices per fuel type, open/closed status
- Purpose: Show Austrian gas stations with live fuel prices; diesel and Super 95 merged by station ID
- License: No formal license published
- URL: https://api.e-control.at/sprit/1.0/doc/index.html
- Commercial use: Unknown — no explicit terms
- Usage limits: None documented; community convention suggests max 1 req/1-2 hours
- Attribution: Not required (no formal requirement found)
- Other: Public unauthenticated API; E-Control could restrict access without notice
- Privacy: https://www.e-control.at/tarifkalkulator/datenschutz
- Country: Austria (Energie-Control Austria, Vienna)
- End-user data exposure: Server-only
- DPA: Not applicable (Austrian government regulator)
- Coverage: Austria (bbox 46.4-49.0N, 9.5-17.2E)
- Env vars: None
- Self-hostable: No

## geocoding-db-ris

### DB RIS Stations API — `https://apis.deutschebahn.com/db/apis/ris-stations/v1`
- Data sent: Search query or coordinates (latitude, longitude, radius) for geocoding; EVA station number for detail enrichment
- Data received: Stop places with EVA number, names (multilingual), coordinates, available transports; platforms with length/height/accessibility; transfer times; local services (shops, lockers, etc.)
- Purpose: Forward/reverse geocoding of German railway stations, plus station detail enrichment (platforms, transfer times, amenities)
- License: Proprietary (custom bilateral license per API product)
- URL: https://developers.deutschebahn.com/db-api-marketplace/apis/nutzungsbedingungen
- Commercial use: Yes, but requires individual license agreement
- Usage limits: Set per API product; DB may limit calls for technical/security reasons
- Attribution: Per individual license
- Other: Content is confidential; DB may discontinue APIs at any time
- Privacy: https://developers.deutschebahn.com/db-api-marketplace/apis/privacypolicy
- Country: Germany (Deutsche Bahn AG)
- End-user data exposure: Server-only
- DPA: Not available (enterprise arrangements may be possible; contact Deutsche Bahn)
- Coverage: Germany (German railway stations only)
- Env vars: `DB_RIS_CLIENT_ID`, `DB_RIS_API_KEY` — required pair
- Self-hostable: No

### DB RIS Routing API — `https://apis.deutschebahn.com/db/apis/ris-routing/v2`
- License: Proprietary (custom bilateral license per API product)
- URL: https://developers.deutschebahn.com/db-api-marketplace/apis/nutzungsbedingungen
- Commercial use: Yes, with individual license agreement
- Usage limits: Set per API product
- Privacy: https://developers.deutschebahn.com/db-api-marketplace/apis/privacypolicy
- Country: Germany (Deutsche Bahn AG)
- Data sent: Not directly called by geocoding-db-ris (used by transit-ris-routing)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Germany
- Env vars: `DB_RIS_CLIENT_ID`, `DB_RIS_API_KEY` — required pair
- Self-hostable: No

### DB RIS Maps API — `https://apis.deutschebahn.com/db/apis/ris-maps/v2`
- License: Proprietary (custom bilateral license per API product)
- URL: https://developers.deutschebahn.com/db-api-marketplace/apis/nutzungsbedingungen
- Commercial use: Yes, with individual license agreement
- Usage limits: Set per API product
- Privacy: https://developers.deutschebahn.com/db-api-marketplace/apis/privacypolicy
- Country: Germany (Deutsche Bahn AG)
- Data sent: Not directly called by geocoding-db-ris (used by overlay-live-transit via live-transit-db-ris)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Germany
- Env vars: `DB_RIS_CLIENT_ID`, `DB_RIS_API_KEY` — required pair
- Self-hostable: No

### DB RIS Transports API — `https://apis.deutschebahn.com/db/apis/ris-transports/v3`
- License: Proprietary (custom bilateral license per API product)
- URL: https://developers.deutschebahn.com/db-api-marketplace/apis/nutzungsbedingungen
- Commercial use: Yes, with individual license agreement
- Usage limits: Set per API product
- Privacy: https://developers.deutschebahn.com/db-api-marketplace/apis/privacypolicy
- Country: Germany (Deutsche Bahn AG)
- Data sent: Not directly called by geocoding-db-ris (used by overlay-live-transit via live-transit-db-ris)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Germany
- Env vars: `DB_RIS_CLIENT_ID`, `DB_RIS_API_KEY` — required pair
- Self-hostable: No

## geocoding-maptiler

### MapTiler Geocoding API — `https://api.maptiler.com/geocoding/{query}.json`
- Data sent: Search query text, language, result limit
- Data received: GeoJSON features with place name, coordinates, place type (poi/address/street), relevance score, categories
- Purpose: Forward geocoding and autocomplete — text search for places, addresses, POIs worldwide
- License: Proprietary
- URL: https://www.maptiler.com/terms/cloud/
- Commercial use: Free plan: non-commercial and R&D only. Paid plans: commercial use allowed.
- Usage limits: Free plan has usage caps (see pricing page); bulk downloading prohibited without written agreement
- Attribution: Yes, always — "© MapTiler © OpenStreetMap contributors" (bottom-right); free plan also requires MapTiler logo (bottom-left)
- Privacy: https://www.maptiler.com/privacy-policy/
- Country: Switzerland (MapTiler AG, Unterägeri, Canton of Zug)
- Privacy other: "Our maps contain no spy code. We don't track end-users to sell them targeted advertisements." Cloudflare CDN stores visitor IPs in memory for max 20 min then auto-deletes. DPAs available for enterprise customers. Data centers in EU (France).
- End-user data exposure: Server-only — geocoding requests go through BFF, not direct from browser
- DPA: Available on request — <https://explore.openli.com/privacy/maptiler-cloud/data-processing-agreements> (contact support@maptiler.com)
- Coverage: Global
- Env vars: `MAPTILER_KEY` — required
- Self-hostable: No (use Nominatim, Photon, or Pelias as self-hosted alternatives)

### MapTiler Reverse Geocoding — `https://api.maptiler.com/geocoding/{lng},{lat}.json`
- Data sent: Coordinates (longitude, latitude), language
- Data received: GeoJSON features with place name, coordinates; context array with municipality, region, country
- Purpose: Reverse geocoding — convert coordinates to a human-readable address
- License: Proprietary
- URL: https://www.maptiler.com/terms/cloud/
- Commercial use: Free plan: non-commercial only. Paid plans: yes.
- Usage limits: Per plan caps; server-side caching/proxying prohibited without written agreement
- Attribution: Yes — "© MapTiler © OpenStreetMap contributors"
- Privacy: https://www.maptiler.com/privacy-policy/
- Country: Switzerland (MapTiler AG)
- End-user data exposure: Server-only
- DPA: Available on request (see MapTiler Geocoding above)
- Coverage: Global
- Env vars: `MAPTILER_KEY` — required
- Self-hostable: No

## geocoding-motis

### Transitous API — `https://api.transitous.org`
- Data sent: Search query text, language
- Data received: Matches with type (STOP/ADDRESS/PLACE), name, coordinates, transport modes, score, timezone
- Purpose: Forward geocoding and autocomplete for transit stops and addresses
- License: AGPL-3.0-or-later (project); FOSS/non-profit use only for public API
- URL: https://transitous.org/api/
- Commercial use: No — explicitly not intended for commercial/for-profit use; case-by-case review available
- Usage limits: No formal limits; must contact team before heavy use; service is best-effort
- Attribution: User-Agent header required (app name + version + contact info)
- Other: Self-hosting encouraged as alternative for commercial use
- Privacy: https://transitous.org/privacy/
- Country: Germany (community project, no formal legal entity; hosted via spline.de, Berlin)
- Privacy other: Logs IP addresses, request URLs, User-Agent; logs retained up to 2 days then deleted
- End-user data exposure: Server-only
- DPA: Not available (community project, no legal entity)
- Coverage: Global (via api.transitous.org)
- Env vars: `TRANSITOUS_URL` — optional (default: `https://api.transitous.org`); `MOTIS_URL` — optional (default: `http://localhost:8081`)
- Self-hostable: Yes — MOTIS Docker image (<https://github.com/motis-project/motis>)

### MOTIS API — `http://localhost:8081/api/v1/plan`
- Data sent: Search query text or coordinates (latitude, longitude), language
- Data received: Matches with type, name, id, coordinates, street, house number, country, transport modes
- Purpose: Forward and reverse geocoding via self-hosted MOTIS instance
- License: MIT (self-hosted software)
- URL: https://github.com/motis-project/motis
- Commercial use: Yes, unrestricted
- Usage limits: N/A (self-hosted)
- Attribution: Yes — MIT copyright notice in distributed copies
- Privacy: -
- Country: Germany (TU Darmstadt; commercially backed by triptix GmbH, Darmstadt)
- Privacy other: Self-hosted — no external data collection; privacy responsibility lies with the operator
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Configurable (depends on loaded data)
- Env vars: `MOTIS_URL` — optional (default: `http://localhost:8081`)
- Self-hostable: Yes — already self-hosted

## geocoding-nominatim

### Nominatim Search — `https://nominatim.openstreetmap.org/search`
- Data sent: Search query text, result limit, language
- Data received: Results with osm_type/id, display_name, lat/lon, class/type (amenity category), importance score
- Purpose: Forward geocoding and autocomplete using OpenStreetMap data
- License: ODbL 1.0 (OSM data)
- URL: https://operations.osmfoundation.org/policies/nominatim/
- Commercial use: Yes, but commercial users risk access withdrawal without notice
- Usage limits: Max 1 req/sec (absolute); results must be cached; single thread for bulk geocoding
- Attribution: Yes — "Data © OpenStreetMap contributors, ODbL"
- Other: Autocomplete, systematic grid queries, and bulk scraping are strictly forbidden; self-hosting recommended for production
- Privacy: https://osmfoundation.org/wiki/Privacy_Policy
- Country: UK (OpenStreetMap Foundation, Cambridge, England)
- Privacy other: IP addresses collected; Matomo tracking with shortened IPs; detailed usage retained 180 days; data stored in UK and Netherlands
- End-user data exposure: Server-only
- DPA: Not available (OSMF acts as independent controller, not processor)
- Coverage: Global
- Env vars: `NOMINATIM_URL` — optional (default: `https://nominatim.openstreetmap.org`)
- Self-hostable: Yes — Docker image available (<https://github.com/mediagis/nominatim-docker>); already in project Docker Compose

### Nominatim Reverse — `https://nominatim.openstreetmap.org/reverse`
- Data sent: Coordinates (latitude, longitude), language
- Data received: Structured address: road, house_number, city/town/village, state, postcode, country
- Purpose: Reverse geocoding — convert coordinates to a structured address
- License: ODbL 1.0 (OSM data)
- URL: https://operations.osmfoundation.org/policies/nominatim/
- Commercial use: Yes, with same caveats as above
- Usage limits: Max 1 req/sec; results must be cached
- Attribution: Yes — "Data © OpenStreetMap contributors, ODbL"
- Privacy: https://osmfoundation.org/wiki/Privacy_Policy
- Country: UK (OpenStreetMap Foundation)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: `NOMINATIM_URL` — optional
- Self-hostable: Yes

## geocoding-pelias

### Pelias Search — `http://localhost:4300/v1/search`
- Data sent: Search query text, result limit, language
- Data received: GeoJSON features with gid, label, name, layer (venue/address/street/locality), confidence, coordinates
- Purpose: Forward geocoding via self-hosted Pelias instance
- License: MIT (self-hosted software)
- URL: https://github.com/pelias/pelias/blob/master/LICENSE
- Commercial use: Yes, unrestricted
- Usage limits: N/A (self-hosted)
- Attribution: Yes — "Copyright (c) 2014 Mapzen" + MIT license text in distributed copies
- Other: Data source licenses (OSM, OpenAddresses, etc.) must be respected separately
- Privacy: -
- Country: US (Linux Foundation project; originally Mapzen, NYC)
- Privacy other: Self-hosted — no external data collection; privacy responsibility lies with the operator
- End-user data exposure: Server-only (self-hosted)
- DPA: Not applicable (self-hosted software)
- Coverage: Configurable (depends on imported data)
- Env vars: `PELIAS_URL` — optional (default: `http://localhost:4300`)
- Self-hostable: Yes — already self-hosted; Docker setup at <https://github.com/pelias/docker>

### Pelias Reverse — `http://localhost:4300/v1/reverse`
- Data sent: Coordinates (latitude, longitude), language
- Data received: GeoJSON feature with label (address), locality, region
- Purpose: Reverse geocoding via self-hosted Pelias
- License: MIT (self-hosted software)
- URL: https://github.com/pelias/pelias/blob/master/LICENSE
- Commercial use: Yes, unrestricted
- Usage limits: N/A (self-hosted)
- Attribution: MIT license text in distributed copies
- Privacy: -
- Country: US (Linux Foundation project)
- End-user data exposure: Server-only (self-hosted)
- DPA: Not applicable (self-hosted)
- Coverage: Configurable
- Env vars: `PELIAS_URL` — optional
- Self-hostable: Yes

### Pelias Autocomplete — `http://localhost:4300/v1/autocomplete`
- Data sent: Partial search query text, result limit, language
- Data received: GeoJSON features with name, locality/region/country (sublabel), coordinates, layer type
- Purpose: Autocomplete/typeahead optimized for partial input via self-hosted Pelias
- License: MIT (self-hosted software)
- URL: https://github.com/pelias/pelias/blob/master/LICENSE
- Commercial use: Yes, unrestricted
- Usage limits: N/A (self-hosted)
- Attribution: MIT license text in distributed copies
- Privacy: -
- Country: US (Linux Foundation project)
- End-user data exposure: Server-only (self-hosted)
- DPA: Not applicable (self-hosted)
- Coverage: Configurable
- Env vars: `PELIAS_URL` — optional
- Self-hostable: Yes

## geocoding-photon

### Photon Search — `https://photon.komoot.io/api`
- Data sent: Search query text, result limit, language
- Data received: GeoJSON features with osm_id/type, name, street, housenumber, city, state, country, osm_key/value
- Purpose: Forward geocoding and autocomplete using Komoot's Photon (OSM-based)
- License: Apache License 2.0 (software); ODbL (OSM data)
- URL: https://github.com/komoot/photon/blob/master/LICENSE
- Commercial use: Yes, unrestricted (software); ODbL share-alike applies to data
- Usage limits: N/A for self-hosted; komoot demo server has fair-use expectations
- Attribution: Yes — Apache license text + OSM attribution
- Privacy: https://www.komoot.com/privacy
- Country: Germany (komoot GmbH, Schönefeld)
- Privacy other: komoot logs IPs for 90 days; photon.komoot.io has no separate privacy policy; DPO: datenschutzbeauftragter@komoot.de
- End-user data exposure: Server-only
- DPA: Not available (demo server has no formal agreement; self-host for production)
- Coverage: Global
- Env vars: `PHOTON_URL` — optional (default: `https://photon.komoot.io`)
- Self-hostable: Yes — Docker + pre-built index (~90 GB worldwide) (<https://github.com/komoot/photon>)

### Photon Reverse — `https://photon.komoot.io/reverse`
- Data sent: Coordinates (latitude, longitude), language
- Data received: GeoJSON feature with street, housenumber, city, state (assembled into address)
- Purpose: Reverse geocoding via Photon
- License: Apache License 2.0 (software); ODbL (OSM data)
- URL: https://github.com/komoot/photon/blob/master/LICENSE
- Commercial use: Yes
- Usage limits: Fair-use on demo server
- Attribution: Yes — Apache license text + OSM attribution
- Privacy: https://www.komoot.com/privacy
- Country: Germany (komoot GmbH)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: `PHOTON_URL` — optional
- Self-hostable: Yes

## overlay-3d-buildings

No external API calls.

## overlay-air-quality

### OpenAQ Locations API — `https://api.openaq.org/v3/locations`
- Data sent: Bounding box coordinates, parameter filter (PM2.5)
- Data received: Station locations with id, name, coordinates, country, provider, sensor IDs, license info
- Purpose: Discover PM2.5 monitoring stations within the map viewport
- License: CC BY 4.0 (varies per data source)
- URL: https://docs.openaq.org/resources/licenses
- Commercial use: Yes, but cannot create products that directly compete with OpenAQ
- Usage limits: 60 req/min, 2,000 req/hr; API key required; higher limits via paid plans
- Attribution: Yes — must acknowledge both original data sources and OpenAQ
- Privacy: https://openaq.org/privacy/
- Country: US (OpenAQ, Inc., 501(c)(3) nonprofit, Washington, DC)
- Privacy other: API registration requires name and email; AWS collects log data; data stored in US
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global (strongest in US, Europe, and South/East Asia)
- Env vars: `OPENAQ_API_KEY` — required
- Self-hostable: No

### OpenAQ Latest — `https://api.openaq.org/v3/locations/{locationId}/latest`
- Data sent: Location ID
- Data received: Latest sensor reading with datetime, PM2.5 concentration value, coordinates
- Purpose: Get most recent PM2.5 reading per station, converted to US EPA AQI score client-side
- License: CC BY 4.0 (varies per data source)
- URL: https://docs.openaq.org/resources/licenses
- Commercial use: Yes (non-competing)
- Usage limits: 60 req/min, 2,000 req/hr; API key required
- Attribution: Yes — original data sources + OpenAQ
- Privacy: https://openaq.org/privacy/
- Country: US (OpenAQ, Inc.)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: `OPENAQ_API_KEY` — required
- Self-hostable: No

## overlay-cycling

No external API calls.

## overlay-earthquakes

### USGS Earthquake Feed — `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{threshold}_{timeRange}.geojson`
- Data sent: Magnitude threshold and time range
- Data received: GeoJSON FeatureCollection: magnitude, place name, time, depth, alert level, tsunami flag, significance score
- Purpose: Display earthquake events on the map, color-coded by depth/recency with magnitude-scaled circles
- License: U.S. Public Domain
- URL: https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits
- Commercial use: Yes, unrestricted
- Usage limits: None specified
- Attribution: Requested (not legally mandated) — "Credit: U.S. Geological Survey"
- Privacy: https://www.doi.gov/privacy
- Country: US (U.S. Geological Survey, federal government)
- Privacy other: Logs IP addresses, browser type, timestamps; uses Google Analytics; no GDPR provisions
- End-user data exposure: Server-only
- DPA: Not applicable (US federal government)
- Coverage: Global
- Env vars: None
- Self-hostable: No (unique USGS data, no alternative)

## overlay-environment

### openSenseMap API — `https://api.opensensemap.org/boxes`
- Data sent: Bounding box coordinates, exposure filter (outdoor/indoor), date
- Data received: Sensor boxes with id, name, coordinates, last measurement time, exposure, model, sensors with latest values (temp, humidity, PM2.5, PM10, pressure, UV, noise)
- Purpose: Fetch environmental sensor stations from the openSenseMap citizen science platform
- License: PDDL 1.0 (data); MIT (code)
- URL: https://opendatacommons.org/licenses/pddl/1-0/
- Commercial use: Yes, unrestricted (public domain equivalent)
- Usage limits: None
- Attribution: Not required
- Privacy: https://sensebox.de/en/privacy.html
- Country: Germany (Reedu GmbH & Co. KG, Münster)
- Privacy other: Uses Matomo analytics self-hosted at University of Münster with anonymized IPs
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global (strongest in Europe)
- Env vars: None
- Self-hostable: No

### Sensor.Community API — `https://data.sensor.community/airrohr/v1/filter/box=...`
- Data sent: Bounding box coordinates, hardware sensor type
- Data received: Sensor entries with id, timestamp, location (lat/lng/country/indoor), sensor type, data values (temperature, humidity, PM10, PM2.5, noise)
- Purpose: Second source for environmental sensors; merged with openSenseMap after deduplication (~50m threshold)
- License: DbCL 1.0
- URL: https://opendatacommons.org/licenses/dbcl/1-0/
- Commercial use: Yes, unrestricted
- Usage limits: None specified
- Attribution: Not required by DbCL itself; check accompanying ODbL for database-level requirements
- Privacy: https://sensor.community/en/privacy-terms/
- Country: Germany (Rajko Zschiegner, individual, Greiz; originated from OK Lab Stuttgart)
- Privacy other: Sensor locations rounded to ~100m; uses Matomo with cookies disabled
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global (strongest in Europe)
- Env vars: None
- Self-hostable: No

## overlay-hiking

### Waymarked Trails Search — `https://hiking.waymarkedtrails.org/api/v1/list/search`
- Data sent: Search query text, result limit
- Data received: Trail results with type, OSM relation id, name, group, symbol description
- Purpose: Search for hiking trails by name
- License: CC BY-SA 3.0 DE (tiles/overlay); ODbL (GPX tracks/OSM data)
- URL: https://hiking.waymarkedtrails.org/#help-legal
- Commercial use: Yes (CC BY-SA and ODbL both allow it)
- Usage limits: Reasonable access rates; bulk downloading of GPX paths not permitted
- Attribution: Yes — "© waymarkedtrails.org, OpenStreetMap contributors, CC by-SA 3.0"
- Privacy: -
- Country: Germany (Sarah Hoffmann, individual, Dresden)
- End-user data exposure: Server-only
- DPA: Not available (individual project, no legal entity)
- Coverage: Global (OSM-based hiking data worldwide)
- Env vars: `WAYMARKED_HIKING_TILE_URL` — optional
- Self-hostable: No

### Waymarked Trails by Area — `https://hiking.waymarkedtrails.org/api/v1/list/by_area`
- Data sent: Bounding box coordinates, result limit
- Data received: Trail results with type, OSM relation id, name, group, symbol description
- Purpose: List hiking trails within the current map viewport
- License: CC BY-SA 3.0 DE (tiles/overlay); ODbL (GPX tracks/OSM data)
- URL: https://hiking.waymarkedtrails.org/#help-legal
- Commercial use: Yes
- Usage limits: Reasonable access rates
- Attribution: Yes — "© waymarkedtrails.org, OpenStreetMap contributors, CC by-SA 3.0"
- Privacy: -
- Country: Germany (Sarah Hoffmann, individual)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: None
- Self-hostable: No

### Waymarked Trails Details — `https://hiking.waymarkedtrails.org/api/v1/details/relation/{id}`
- Data sent: OSM relation ID
- Data received: Trail detail: name, operator, length, bbox, wikipedia link, tags, symbol info
- Purpose: Fetch detailed metadata for a specific hiking trail
- License: CC BY-SA 3.0 DE (tiles/overlay); ODbL (GPX tracks/OSM data)
- URL: https://hiking.waymarkedtrails.org/#help-legal
- Commercial use: Yes
- Attribution: Yes — "© waymarkedtrails.org, OpenStreetMap contributors, CC by-SA 3.0"
- Privacy: -
- Country: Germany
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: None
- Self-hostable: No

### Waymarked Hiking Tiles — `https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png`
- Data sent: Tile coordinates (z/x/y)
- Data received: PNG raster tile showing hiking trail overlay
- Purpose: Render hiking trail overlay tiles on the map
- License: CC BY-SA 3.0 DE (tiles/overlay); ODbL (GPX tracks/OSM data)
- URL: https://hiking.waymarkedtrails.org/#help-legal
- Commercial use: Yes
- Usage limits: Reasonable access rates; caching encouraged
- Attribution: Yes — "© waymarkedtrails.org, OpenStreetMap contributors, CC by-SA 3.0"
- Privacy: -
- Country: Germany
- End-user data exposure: Proxied via BFF — browser calls our API server at /api/integrations/overlay-hiking/tiles/, which fetches from tile.waymarkedtrails.org; only our server IP is exposed
- DPA: Not available
- Coverage: Global
- Env vars: `WAYMARKED_HIKING_TILE_URL` — optional
- Self-hostable: No

### Refuges.info API — `https://www.refuges.info/api/bbox`
- Data sent: Bounding box coordinates, optional shelter type filter
- Data received: GeoJSON with refuge name, type (shelter/hut/bivouac), altitude, bed capacity, coordinates
- Purpose: Display mountain shelters, refuges, water points, and cabins on the hiking map
- License: CC BY-SA 2.0 FR
- URL: https://www.refuges.info/wiki/licence
- Commercial use: Yes
- Usage limits: None specified
- Attribution: Yes — "© Les contributeurs de Refuges.info" (for point data); "© [Author] sur refuges.info" (for comments/photos)
- Privacy: https://www.refuges.info/wiki/mentions-legales
- Country: France (volunteer-run, non-commercial; hosted by Gplservice, Challes-les-eaux)
- Privacy other: No cookies for general map/API use; login sets 5 cookies (PhpBB + CleanTalk)
- End-user data exposure: Server-only
- DPA: Not available (volunteer project)
- Coverage: Europe (strongest in France/Alps)
- Env vars: None
- Self-hostable: No

### Overpass API — via `@openmapx/core` `overpassQuery()`
- Data sent: OSM relation ID (embedded in Overpass QL query)
- Data received: Relation members with inline geometry (lat/lon), way tags (sac_scale difficulty, surface, highway type)
- Purpose: Fetch full geometry of a hiking trail with per-segment SAC difficulty grading
- License: ODbL 1.0 (OSM data)
- URL: https://www.openstreetmap.org/copyright
- Commercial use: Yes
- Attribution: Yes — "© OpenStreetMap contributors" with link to openstreetmap.org/copyright
- Other: ODbL share-alike applies to derivative databases; produced works (rendered maps) require attribution only
- Privacy: https://osmfoundation.org/wiki/Privacy_Policy
- Country: UK (OpenStreetMap Foundation)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: None
- Self-hostable: Yes — Docker image (<https://github.com/wiktorn/Overpass-API>)

## overlay-live-transit

### Deutsche Bahn RIS APIs — via shared `db-ris` service
- Data sent: Railway administration IDs (operator filter)
- Data received: Live + emulated train positions with journeyID, lat/lng, direction, speed, train category/name, origin/destination
- Purpose: Contribute Germany rail vehicle positions to the generic live-transit overlay
- License: Proprietary (custom bilateral license per API product)
- URL: https://developers.deutschebahn.com/db-api-marketplace/apis/nutzungsbedingungen
- Commercial use: Yes, with individual license agreement
- Usage limits: Set per API product
- Privacy: https://developers.deutschebahn.com/db-api-marketplace/apis/privacypolicy
- Country: Germany (Deutsche Bahn AG)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Germany
- Env vars: None (uses shared DB RIS credentials from geocoding-db-ris)
- Self-hostable: No

### Entur Vehicle Positions v2 — `https://api.entur.io/realtime/v2/vehicles/graphql`
- Data sent: Viewport bounding box, max data age, monitored-only filter, `ET-Client-Name` header
- Data received: Realtime transit vehicle ids, positions, bearing, speed, line/public code, operator, service journey ids, monitored stop refs
- Purpose: Contribute realtime public-transit vehicle positions to the live-transit overlay
- License: NLOD 2.0
- URL: https://data.norge.no/nlod/en/2.0
- Commercial use: Yes
- Attribution: Yes — "Data made available by Entur"
- Privacy: https://om.entur.no/personvern/
- Country: Norway (Entur AS)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Norway
- Env vars: None required; optional integration config overrides: `clientName`, `journeyPlannerEndpoint`, `vehiclesEndpoint`
- Self-hostable: No

### Entur Journey Planner Situations API — `https://api.entur.io/journey-planner/v3/graphql`
- Data sent: `ET-Client-Name` header; no end-user identifiers; situations are filtered server-side to the current viewport after fetch
- Data received: Public transport situations/alerts with summary, description, severity, validity period, affected lines, stop places, quays
- Purpose: Add provider alerts and disruption badges to the live-transit overlay
- License: NLOD 2.0
- URL: https://data.norge.no/nlod/en/2.0
- Commercial use: Yes
- Attribution: Yes — "Data made available by Entur"
- Privacy: https://om.entur.no/personvern/
- Country: Norway (Entur AS)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Norway
- Env vars: None required; optional integration config overrides: `clientName`, `journeyPlannerEndpoint`, `vehiclesEndpoint`
- Self-hostable: No

## overlay-natural-events

### NASA EONET API — `https://eonet.gsfc.nasa.gov/api/v3/events/geojson`
- Data sent: Event status filter, optional day range and category
- Data received: GeoJSON points with event title, description, date, magnitude, categories (volcano/storm/flood/etc.), source URLs. Earthquakes and wildfires excluded (separate overlays).
- Purpose: Display natural events (volcanoes, storms, floods, landslides) on the map
- License: U.S. Public Domain
- URL: https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance
- Commercial use: Yes — but cannot imply NASA endorsement
- Usage limits: None specified
- Attribution: Strongly urged — "NASA should be acknowledged as the source"
- Privacy: https://www.nasa.gov/privacy/
- Country: US (NASA, federal government)
- Privacy other: Logs IP addresses, browser info, timestamps; uses Google Analytics; no GDPR provisions
- End-user data exposure: Server-only
- DPA: Not applicable (US federal government)
- Coverage: Global
- Env vars: None
- Self-hostable: No (unique NASA data)

### GDACS API — `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH`
- Data sent: Event type filter, date range, alert level filter
- Data received: GeoJSON with event type/id, name, alert level/score, country, severity data, report URLs
- Purpose: Second source for natural disasters; deduplicated against EONET (80km same-category threshold). Provides alert levels.
- License: Proprietary (disclaimer-based terms, no standard open license)
- URL: https://www.gdacs.org/About/termofuse.aspx
- Commercial use: No — "reproduction is permitted provided the source is acknowledged, except for commercial purposes"
- Usage limits: None specified
- Attribution: Yes — acknowledge GDACS as source
- Other: Not a substitute for official disaster alerts; data requires further validation
- Privacy: https://commission.europa.eu/privacy-policy-websites-managed-european-commission_en
- Country: Belgium / EU (European Commission JRC + UN OCHA)
- Privacy other: Falls under EU Regulation 2018/1725; server logs retained up to 1 year; European Data Protection Supervisor oversight
- End-user data exposure: Server-only
- DPA: Not applicable (EU institution, Regulation 2018/1725)
- Coverage: Global
- Env vars: None
- Self-hostable: No (unique UN/EU disaster data)

## overlay-satellite

### NASA GIBS WMTS Capabilities — `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&request=GetCapabilities`
- Data sent: No user data (static capabilities request)
- Data received: XML with layer definitions, available date ranges, legend URLs for 7 satellite imagery layers
- Purpose: Discover available dates and legends for satellite imagery layers (MODIS, VIIRS, NDVI, snow, SST, etc.)
- License: U.S. Public Domain
- URL: https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance
- Commercial use: Yes — cannot imply NASA endorsement
- Usage limits: None specified
- Attribution: Strongly urged — cite NASA as source
- Privacy: https://www.nasa.gov/privacy/
- Country: US (NASA)
- End-user data exposure: Server-only (capabilities fetched at init and cached)
- DPA: Not applicable (US federal government)
- Coverage: Global
- Env vars: None
- Self-hostable: No (unique NASA satellite imagery)

### NASA GIBS Tiles — `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{identifier}/default/{date}/{tileMatrixSet}/{z}/{y}/{x}.{format}`
- Data sent: Layer identifier, date, tile coordinates (z/y/x)
- Data received: Raster tile (JPEG or PNG depending on layer)
- Purpose: Serve satellite imagery tiles for the selected layer and date
- License: U.S. Public Domain
- URL: https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance
- Commercial use: Yes
- Attribution: Strongly urged
- Privacy: https://www.nasa.gov/privacy/
- Country: US (NASA)
- End-user data exposure: Proxied via BFF — tiles served through /api/integrations/overlay-satellite/tiles/; only our server IP is exposed to NASA
- DPA: Not applicable (US federal government)
- Coverage: Global
- Env vars: None
- Self-hostable: No

### NASA GIBS Legends — `https://gibs.earthdata.nasa.gov/legends/{filename}`
- Data sent: Legend filename
- Data received: PNG colorbar legend image for data visualization layers
- Purpose: Display color scale legends for satellite data layers
- License: U.S. Public Domain
- URL: https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance
- Commercial use: Yes
- Attribution: Strongly urged
- Privacy: https://www.nasa.gov/privacy/
- Country: US (NASA)
- End-user data exposure: Proxied via BFF
- DPA: Not applicable (US federal government)
- Coverage: Global
- Env vars: None
- Self-hostable: No

## overlay-traffic-tomtom

### TomTom Traffic Tiles — configured via environment variable
- Data sent: Tile coordinates (z/x/y), traffic style
- Data received: PNG raster tile showing traffic flow conditions (color-coded road segments)
- Purpose: Display real-time traffic conditions on the map
- License: Proprietary
- URL: https://developer.tomtom.com/terms-and-conditions
- Commercial use: Yes, with paid subscription plan
- Usage limits: QPS limits apply; exceeding limits or creating multiple accounts for free requests may result in suspension
- Attribution: Yes — must implement TomTom Copyright API or preserve auto-generated logos/notices
- Other: No derivative works; caching limited to max-age headers; AI/ML training on TomTom data is prohibited; no competitive benchmarking
- Privacy: https://www.tomtom.com/en_us/privacy/general/
- Country: Netherlands (TomTom International B.V.)
- Privacy other: GDPR-compliant; two-step randomization to prevent re-identification; DPA available; API Gateway routes through regional servers for data residency
- End-user data exposure: Proxied via BFF — tiles served through /api/traffic/flow/; only our server IP is exposed to TomTom
- DPA: Available — <https://www.tomtom.com/legal/en_gb/third-party-product-terms/data-processing-schedule/>
- Coverage: Global
- Env vars: `TOMTOM_TRAFFIC_KEY` — required (set in apps/api)
- Self-hostable: No (real-time traffic requires proprietary probe data)

## overlay-transit

No external API calls.

## overlay-weather

### RainViewer API — `https://api.rainviewer.com/public/weather-maps.json`
- Data sent: No user data (static metadata feed)
- Data received: CDN host URL, past radar frames and nowcast predictions with Unix timestamps and tile path templates
- Purpose: Get metadata for precipitation radar animation frames (past observations + nowcast predictions)
- License: Proprietary (free for personal/educational use only)
- URL: https://www.rainviewer.com/terms.html
- Commercial use: Personal/educational use only; commercial use likely requires separate agreement
- Usage limits: 100 req/IP/min
- Attribution: Yes — mention "Rain Viewer" with link to rainviewer.com; preserve watermarks on radar images
- Privacy: https://www.rainviewer.com/privacy.html
- Country: US (Meteolab Inc., Delaware)
- End-user data exposure: Proxied via BFF — radar tiles proxied through /api/integrations/overlay-weather/radar/tile/; only our server IP is exposed to RainViewer
- DPA: Not available
- Coverage: Global (weather radar coverage)
- Env vars: None
- Self-hostable: No (proprietary radar compositing; no open-source alternative)

### OpenWeatherMap Tiles — `https://tile.openweathermap.org/map/{layer}/{z}/{x}/{y}.png`
- Data sent: Weather layer name, tile coordinates (z/x/y)
- Data received: PNG tile showing the selected weather parameter (temperature, clouds, wind, pressure, or precipitation)
- Purpose: Display weather parameter overlay tiles on the map
- License: ODbL
- URL: https://openweathermap.org/full-price
- Commercial use: Yes, on all plans including free
- Usage limits: Free: 60 calls/min, 1,000/day. Paid tiers scale up to 100,000/min.
- Attribution: Yes — "Weather data © OpenWeather" must be visible where data appears (not just in legal pages)
- Privacy: https://openweather.co.uk/privacy-policy
- Country: UK (OpenWeather Ltd, London)
- Privacy other: Does NOT store API request parameters (locations, ZIP codes) or retain IP addresses from API requests
- End-user data exposure: Proxied via BFF — tiles served through /api/integrations/overlay-weather/tiles/; only our server IP is exposed
- DPA: Not available (may be negotiable for enterprise; contact info@openweathermap.org)
- Coverage: Global
- Env vars: `OWM_API_KEY` — optional; radar (RainViewer) works without it
- Self-hostable: No (use Open-Meteo for self-hosted weather data, but no equivalent tile service)

## overlay-weather-alerts

### NOAA Weather Alerts — `https://api.weather.gov/alerts/active`
- Data sent: No user data (static active alerts feed)
- Data received: GeoJSON with polygon geometries; properties: headline, event, severity, urgency, description, instruction, onset/expires, area description
- Purpose: Display US weather alerts (warnings, watches, advisories) with polygon boundaries
- License: U.S. Public Domain
- URL: https://www.weather.gov/disclaimer
- Commercial use: Yes — cannot claim ownership, imply NOAA endorsement, or present modified content as official
- Usage limits: No specific numeric limit; abuse-based throttling applies; align frequency to data refresh
- Attribution: Recommended — preserve original NWS attribution if present
- Privacy: https://www.weather.gov/privacy
- Country: US (NOAA / National Weather Service, federal government)
- Privacy other: US government — no GDPR; logs IP addresses; may share with other federal agencies for law enforcement
- End-user data exposure: Server-only
- DPA: Not applicable (US federal government)
- Coverage: United States
- Env vars: None
- Self-hostable: No

### ECCC Weather Alerts (Canada) — `https://api.weather.gc.ca/collections/weather-alerts/items`
- Data sent: No user data (static active alerts feed)
- Data received: GeoJSON with polygon geometries; alert type, name (EN/FR), urgency, confidence, publication/expiration dates, province
- Purpose: Display Canadian weather alerts with polygon boundaries
- License: ECCC Data Servers End-use Licence v2.1
- URL: https://eccc-msc.github.io/open-data/licence/readme_en/
- Commercial use: Yes, worldwide, royalty-free, perpetual
- Usage limits: None specified
- Attribution: Yes — "Data Source: Environment and Climate Change Canada"
- Other: Weather alerts must be reproduced without altering content or intent
- Privacy: https://www.canada.ca/en/transparency/privacy.html
- Country: Canada (Environment and Climate Change Canada, federal government)
- Privacy other: Canadian Privacy Act (not GDPR); web analytics data stored in US (Adobe Analytics)
- End-user data exposure: Server-only
- DPA: Not applicable (Canadian federal government)
- Coverage: Canada
- Env vars: None
- Self-hostable: No

### DWD GeoServer WFS (Germany) — `https://maps.dwd.de/geoserver/dwd/ows`
- Data sent: No user data (static active warnings feed)
- Data received: GeoJSON with municipality-level polygon geometries; headline, event, severity, urgency, description, instruction, onset/expires
- Purpose: Display German weather warnings with municipality-level polygon boundaries
- License: CC BY 4.0
- URL: https://www.dwd.de/DE/leistungen/opendata/faqs_opendata.html
- Commercial use: Yes, explicitly encouraged
- Usage limits: None specified; no guaranteed availability
- Attribution: Yes — "Quelle: Deutscher Wetterdienst" or DWD logo (min 127x34px); for modified data: "Datenbasis: Deutscher Wetterdienst, [modification description]"
- Privacy: https://www.dwd.de/EN/service/dataprotection/dataprotection_node.html
- Country: Germany (Deutscher Wetterdienst, Offenbach)
- Privacy other: GDPR-compliant; IP addresses in server logs deleted after 183 days; AWS used for hosting
- End-user data exposure: Server-only
- DPA: Available — <https://www.dwd.de/DE/derdwd/_functions/Boxen/vereinbarung_auftragsverarbeitung.html> (downloadable AVV template)
- Coverage: Germany
- Env vars: None
- Self-hostable: No (but Bright Sky wraps DWD data and is self-hostable)

### MeteoAlarm Atom+CAP Feeds (Europe) — `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-{country_code}`
- Data sent: Country code (per-country feed selection)
- Data received: Atom XML with CAP alert entries: event, severity, urgency, certainty, onset/expires, area description. No polygon geometry — country centroid used.
- Purpose: Display pan-European weather alerts as point circles at country centroids
- License: CC BY 4.0
- URL: https://feeds.meteoalarm.org/
- Commercial use: Yes
- Usage limits: Authorization and rate limiting via MeteoGate API Gateway (specifics not published)
- Attribution: Yes — "Data provided by EUMETNET members"
- Privacy: https://www.eumetnet.eu/legal-information/
- Country: Belgium (SNC EUMETNET, Brussels)
- Privacy other: Uses Plausible Analytics (privacy-friendly, self-hosted); contact form data stored max 1 year
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Europe (24 countries, excl. Germany — covered by DWD)
- Env vars: None
- Self-hostable: No

## overlay-wildfires

### NASA FIRMS API — `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{mapKey}/{source}/world/{dayRange}`
- Data sent: Satellite source (VIIRS or MODIS), day range (1-3)
- Data received: CSV with lat, lon, acquisition date/time, confidence, satellite, fire radiative power (MW), temperature (K). Low-confidence detections filtered out.
- Purpose: Display active wildfire/fire detections globally, sized by fire radiative power and colored by recency
- License: U.S. Public Domain
- URL: https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance
- Commercial use: Yes — cannot imply NASA endorsement
- Usage limits: None specified
- Attribution: Strongly urged — cite NASA as source
- Privacy: https://www.nasa.gov/privacy/
- Country: US (NASA)
- End-user data exposure: Server-only
- DPA: Not applicable (US federal government)
- Coverage: Global
- Env vars: `FIRMS_MAP_KEY` — required
- Self-hostable: No (unique NASA fire detection data)

## overlay-winter-sports

### OpenSnowMap Tiles — `https://tiles.opensnowmap.org/pistes/{z}/{x}/{y}.png`
- Data sent: Tile coordinates (z/x/y)
- Data received: PNG raster tile showing ski piste overlay
- Purpose: Render ski piste/winter sports raster overlay on the map
- License: CC BY-SA (tiles); ODbL (OSM data)
- URL: https://www.opensnowmap.org/iframes/about.eng.html
- Commercial use: Yes (CC BY-SA and ODbL both allow it)
- Usage limits: Must use valid referer; bulk downloads prohibited; only piste-only tiles available for external use (not relief overlay)
- Attribution: Yes — "Data © www.openstreetmap.org & contributors ODBL and www.opensnowmap.org CC-BY-SA"
- Privacy: -
- Country: France (Yves Cainaud, individual, Jura region)
- Privacy other: Hobby project; no user accounts or tracking
- End-user data exposure: Proxied via BFF — tiles served through /api/integrations/overlay-winter-sports/tiles/; only our server IP is exposed
- DPA: Not available (individual project, no legal entity)
- Coverage: Global (OSM-based ski data)
- Env vars: `OPENSNOWMAP_TILE_URL` — optional
- Self-hostable: Partially — piste overlay can be generated from OSM data; relief layer is resource-intensive

## parking

### ParkenDD API — `https://api.parkendd.de`
- Data sent: No user data (static city list endpoint); city name for lot retrieval
- Data received: City list with coordinates and source info; per-city lots with name, address, coordinates, total/free capacity, state
- Purpose: Show real-time parking lot availability across European cities
- License: MIT (API software); data licenses vary by city
- URL: https://github.com/ParkenDD/park-api-v3
- Commercial use: Yes (MIT software); data license per city source
- Usage limits: None specified for software; operational defaults: real-time data pulled every 5 min
- Attribution: MIT license notice in distributed copies; data attribution per city
- Privacy: https://parkendd.de/impressum.html
- Country: Germany (Johannes Kliemann, individual, Dresden; community open-source project)
- End-user data exposure: Server-only
- DPA: Not available (individual/community project)
- Coverage: Primarily Germany + select European cities
- Env vars: None
- Self-hostable: Yes — MIT-licensed park-api-v3 (<https://github.com/ParkenDD/park-api-v3>)

### MobiData BW ParkAPI — `https://api.mobidata-bw.de/park-api/api/public/v3/parking-sites`
- Data sent: No user data (fetches entire dataset); site ID for detail lookup
- Data received: Parking sites with name, address, coordinates, capacity, realtime free capacity, type, fee info, opening hours, operator
- Purpose: Show German parking sites with real-time occupancy data
- License: Datenlizenz Deutschland Namensnennung 2.0
- URL: https://www.mobidata-bw.de/pages/nutzungsbedingungen
- Commercial use: Yes
- Usage limits: API key required (free, with signed usage agreement)
- Attribution: Yes — "Datensatz der NVBW GmbH" with link to https://www.nvbw.de/open-data
- Privacy: https://www.mobidata-bw.de/pages/datenschutz
- Country: Germany (NVBW GmbH, Stuttgart, Baden-Württemberg; state-owned)
- Privacy other: GDPR-compliant; server logs deleted after 6 months; EU data processors preferred
- End-user data exposure: Server-only
- DPA: Likely available on request (German state-owned company; contact mobidata-bw@nvbw.de)
- Coverage: Germany (bbox 45.5-55.5N, 5.5-15.5E)
- Env vars: None
- Self-hostable: No

### DB BahnPark API — `https://apis.deutschebahn.com/db-api-marketplace/apis/parking-information/db-bahnpark/v2/parking-facilities`
- Data sent: No user data (fetches entire dataset); facility ID for detail lookup
- Data received: ~312 DB station parking facilities with name, address, coordinates, capacity, tariff/pricing, accessibility, EV charging info
- Purpose: Show Deutsche Bahn station parking facilities across Germany
- License: Proprietary (custom bilateral license per API product)
- URL: https://developers.deutschebahn.com/db-api-marketplace/apis/nutzungsbedingungen
- Commercial use: Yes, with individual license agreement
- Usage limits: Set per API product
- Privacy: https://developers.deutschebahn.com/db-api-marketplace/apis/privacypolicy
- Country: Germany (Deutsche Bahn AG)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Germany (~312 DB station parking facilities)
- Env vars: `DB_PARKING_CLIENT_ID`, `DB_PARKING_API_KEY` — optional pair
- Self-hostable: No

### Overpass API — via `overpassQuerySafe()`
- Data sent: Bounding box coordinates, OSM element type and ID for detail lookup
- Data received: OSM elements with name, coordinates, capacity (total/disabled/charging), fee, access, operator, opening hours
- Purpose: Find parking facilities from OpenStreetMap within the viewport
- License: ODbL 1.0 (OSM data)
- URL: https://www.openstreetmap.org/copyright
- Commercial use: Yes
- Attribution: Yes — "© OpenStreetMap contributors"
- Privacy: https://osmfoundation.org/wiki/Privacy_Policy
- Country: UK (OpenStreetMap Foundation)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global (static OSM parking data, no real-time availability)
- Env vars: None
- Self-hostable: Yes — self-hosted Overpass

## photos-flickr

### Flickr REST API — `https://api.flickr.com/services/rest/`
- Data sent: Coordinates (latitude, longitude), search radius (0.5 km), result limit
- Data received: Photos with multiple size URLs, owner name, license ID (mapped to CC name/URL), capture date
- Purpose: Find openly-licensed photos near a place for the place detail panel
- License: Proprietary
- URL: https://www.flickr.com/help/terms/api
- Commercial use: Yes, but commercial API keys require staff review and approval
- Usage limits: 3,600 queries/hr per API key; results/images may be cached up to 24 hrs
- Attribution: Per individual photo's license — credit author, cite title, link to photo page on Flickr, cite CC license
- Other: Screen scraping prohibited; SmugMug may charge for high-volume commercial use in future
- Privacy: https://www.flickr.com/help/privacy
- Country: US (Flickr, Inc. / SmugMug, California)
- Privacy other: Collects EXIF metadata including location; DPA available; EU/UK Data Privacy Framework certified; EU representative: DP-Dock GmbH (Germany)
- End-user data exposure: Server-only — photo metadata fetched by BFF; images proxied via /api/image-proxy/
- DPA: Available — <https://www.flickr.com/help/dpa>
- Coverage: Global
- Env vars: `FLICKR_API_KEY` — optional; returns empty if unset
- Self-hostable: No (no equivalent geo-photo database)

## photos-mapillary

### Mapillary Graph API — `https://graph.mapillary.com/images`
- Data sent: Bounding box coordinates (~660 m around point), result limit
- Data received: Images with id, coordinates, thumbnail URLs, capture timestamp, creator username, panoramic flag. Sorted by distance, closest N selected.
- Purpose: Find street-level photos near a place for the place detail panel
- License: CC BY-SA 4.0 (imagery); Proprietary (API service terms)
- URL: https://www.mapillary.com/terms
- Commercial use: Yes, but restricted — allowed for product development and client services; reselling and real-time navigation prohibited
- Usage limits: No published numeric limits; Mapillary may throttle or revoke access
- Attribution: Yes — display Mapillary logo and link to homepage or image page
- Privacy: https://www.mapillary.com/privacy
- Country: Ireland / US (Meta Platforms Ireland Limited; originally Mapillary AB, Sweden, acquired by Meta 2020)
- Privacy other: GDPR-compliant; collects IP addresses, device IDs, location data; data shared with Meta affiliates; automated face/license plate blurring on imagery
- End-user data exposure: Server-only — photo metadata fetched by BFF; images proxied via /api/image-proxy/
- DPA: Not available (Meta acts as independent controller, not processor)
- Coverage: Global
- Env vars: `MAPILLARY_TOKEN` — optional; returns empty if unset
- Self-hostable: No (use Panoramax as open alternative: <https://docs.panoramax.fr/>)

## photos-panoramax

### Panoramax API — `https://api.panoramax.xyz/api/search`
- Data sent: Bounding box coordinates (~660 m around point), result limit
- Data received: GeoJSON features with id, coordinates, datetime, license (SPDX), provider/producer name, thumbnail/SD/HD asset URLs
- Purpose: Find open street-level imagery from the Panoramax platform near a place
- License: Licence Ouverte / Etalab 2.0 (IGN instance); CC BY-SA 4.0 (OSM France instance)
- URL: https://docs.panoramax.fr/
- Commercial use: Yes
- Usage limits: Not specified; individual instances may set own limits
- Attribution: Yes — credit photographer/uploader per CC BY-SA or Etalab requirements
- Other: Federated architecture — each instance may have different licenses
- Privacy: https://www.ign.fr/institut/donnees-caractere-personnel
- Country: France (IGN, Institut national de l'information géographique et forestière, Saint-Mandé)
- Privacy other: GDPR-compliant; faces and license plates automatically blurred (CNIL compliance); DPO: dpo@ign.fr
- End-user data exposure: Server-only — photo metadata fetched by BFF; images proxied via /api/image-proxy/
- DPA: Not available (contact IGN for arrangements)
- Coverage: Global (strongest in France)
- Env vars: None
- Self-hostable: Yes — federated, Docker setup available (<https://docs.panoramax.fr/api/install/install/>)

## photos-wikimedia

### Wikimedia Commons API — `https://commons.wikimedia.org/w/api.php`
- License: Per-file (most CC BY-SA 4.0, CC BY 4.0, or Public Domain)
- URL: https://commons.wikimedia.org/wiki/Commons:Licensing
- Commercial use: Yes — all files on Commons must allow commercial use
- Attribution: Per individual file license
- Data sent: Coordinates (latitude, longitude), search radius (500 m), result limit
- Data received: File pages with thumbnail URL (800px), artist, license short name/URL, capture date, coordinates. Filtered: no SVG/PDF/TIFF, max 50MB, max 8000px.
- Purpose: Find openly-licensed photographs from Wikimedia Commons geotagged near a place
- Privacy: https://foundation.wikimedia.org/wiki/Policy:Privacy_policy
- Country: US (Wikimedia Foundation)
- End-user data exposure: Server-only — photo metadata fetched by BFF; images proxied via /api/image-proxy/
- DPA: Not available (Wikimedia Foundation acts as independent controller)
- Coverage: Global
- Env vars: None
- Self-hostable: Partially

## poi-overpass

### Overpass API — `https://overpass-api.de/api/interpreter`
- Data sent: Bounding box coordinates, POI category (OSM tag filters)
- Data received: OSM elements with name (or fallback label), coordinates, tags (address, phone, website, opening_hours, amenity/tourism/leisure category)
- Purpose: Category-based POI search (e.g., nearby restaurants, pharmacies, ATMs) using OpenStreetMap data
- License: ODbL 1.0 (OSM data)
- URL: https://www.openstreetmap.org/copyright
- Commercial use: Yes
- Attribution: Yes — "© OpenStreetMap contributors" with link to openstreetmap.org/copyright
- Other: ODbL share-alike applies to derivative databases
- Privacy: https://osmfoundation.org/wiki/Privacy_Policy
- Country: UK (OpenStreetMap Foundation)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: None
- Self-hostable: Yes — Docker image (<https://github.com/wiktorn/Overpass-API>); already in project Docker Compose

## routing-osrm

### OSRM Route API — `https://router.project-osrm.org/route/v1/driving/{coords}`
- Data sent: Route waypoint coordinates, optional avoidance options (motorway, toll, ferry)
- Data received: Routes with GeoJSON geometry, distance/duration, per-leg summary, turn-by-turn steps with maneuver type/modifier/instruction and step geometry. Up to 3 alternatives.
- Purpose: Car routing with turn-by-turn directions
- License: BSD 2-Clause (software); custom demo server usage policy
- URL: https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy
- Commercial use: Conditionally — service must be publicly accessible with attribution; selling access is strictly forbidden; no paywalls
- Usage limits: No specific numeric limits; excessive use causing instability will be blocked; valid User-Agent required
- Attribution: Yes — display ODbL data license and "OSRM" as route source
- Other: Access may be withdrawn at any time without reason; no quality guarantees
- Privacy: https://www.fossgis.de/datenschutzerkl%C3%A4rung/
- Country: Germany (FOSSGIS e.V., Berlin; operates the demo server)
- Privacy other: Route requests saved in server logs; IP addresses collected but stated not attributable to individuals; no cookies; GDPR Art. 6(1)(f)
- End-user data exposure: Server-only
- DPA: Not available (FOSSGIS e.V. demo server, no DPA offered)
- Coverage: Global (default public instance)
- Env vars: `OSRM_URL` — optional (default: `https://router.project-osrm.org`)
- Self-hostable: Yes — Docker image (<https://hub.docker.com/r/osrm/osrm-backend/>); already in project Docker Compose

### OSRM Trip API — `https://router.project-osrm.org/trip/v1/driving/{coords}`
- Data sent: Route waypoint coordinates, optional avoidance options (motorway, toll, ferry)
- Data received: Optimized trip with same route structure as /route, plus waypoint_index giving optimized visit order
- Purpose: Waypoint optimization (Traveling Salesman) — reorders intermediate stops for shortest total route
- License: BSD 2-Clause (software); custom demo server usage policy
- URL: https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy
- Commercial use: Conditionally — same as above
- Usage limits: Same as above
- Attribution: Yes — ODbL + OSRM source
- Privacy: https://www.fossgis.de/datenschutzerkl%C3%A4rung/
- Country: Germany (FOSSGIS e.V.)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: `OSRM_URL` — optional
- Self-hostable: Yes

## routing-valhalla

### Valhalla Route API — `https://valhalla1.openstreetmap.de/route`
- Data sent: Route waypoint coordinates, travel mode, avoidance options (highways, ferry), unit preference, language
- Data received: Trip with polyline6-encoded geometry, localized turn-by-turn instructions, distance/duration, elevation profile (30m intervals). Up to 3 alternatives.
- Purpose: Multi-modal routing (walking, cycling, driving) with elevation profiles and localized instructions
- License: MIT (software); fair-use demo server policy
- URL: https://github.com/valhalla/valhalla/blob/master/COPYING
- Commercial use: Yes (MIT software); demo server has fair-use expectations similar to OSRM
- Usage limits: Demo server: ~1 req/user/sec, ~100 req/sec total; intended for testing, not production
- Attribution: Yes — MIT copyright notice (Valhalla contributors, Mapillary AB, Mapzen) + OSM ODbL attribution
- Privacy: https://www.fossgis.de/datenschutzerkl%C3%A4rung/
- Country: Germany (FOSSGIS e.V.; same operator as OSRM demo)
- End-user data exposure: Server-only
- DPA: Not available (FOSSGIS e.V. demo server, no DPA offered)
- Coverage: Global (default public instance)
- Env vars: `VALHALLA_URL` — optional (default: `https://valhalla1.openstreetmap.de`)
- Self-hostable: Yes — Docker image (<https://github.com/nilsnolde/docker-valhalla>); already in project Docker Compose

### Valhalla Optimized Route API — `https://valhalla1.openstreetmap.de/optimized_route`
- Data sent: Route waypoint coordinates, travel mode, avoidance options (highways, ferry), unit preference, language
- Data received: Same route structure plus original_index per location giving optimized visit order
- Purpose: Waypoint optimization for walking/cycling/driving — reorders intermediate stops
- License: MIT (software); fair-use demo server policy
- URL: https://github.com/valhalla/valhalla/blob/master/COPYING
- Commercial use: Yes (MIT)
- Usage limits: Same demo server fair-use as above
- Attribution: MIT copyright notice + OSM ODbL
- Privacy: https://www.fossgis.de/datenschutzerkl%C3%A4rung/
- Country: Germany (FOSSGIS e.V.)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: `VALHALLA_URL` — optional
- Self-hostable: Yes

## scooter-sharing

### GBFS Catalog — `https://raw.githubusercontent.com/MobilityData/gbfs/master/systems.csv`
- Data sent: No user data (static catalog)
- Data received: CSV of all worldwide GBFS systems with country, name, system ID, auto-discovery URL
- Purpose: Discover GBFS-compliant shared mobility feeds worldwide; filtered by country bbox overlap
- License: CC BY 3.0 (spec); data feeds default to CC0 if no license specified
- URL: https://github.com/MobilityData/gbfs/blob/master/data-licenses.md
- Commercial use: Yes — all four recommended licenses (CC0, CC-BY-4.0, CDLA-Permissive-1.0, ODC-By-1.0) permit it
- Attribution: Depends on feed's chosen license; CC0 requires none, others require attribution
- Other: Check license_url field in each feed's system_information.json
- Privacy: https://mobilitydata.org/privacy-policy/
- Country: Canada (MobilityData, independent non-profit, Montreal)
- Privacy other: GBFS spec is GDPR-compliant by design (mandatory rotation of vehicle IDs prevents journey reconstruction)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: None
- Self-hostable: No

### GBFS Dynamic Systems — per-operator auto-discovery URLs
- Data sent: No user data (fetches static feeds per system)
- Data received: Station locations/capacity/availability, free-floating vehicle positions, vehicle type metadata (form factor, propulsion), pricing plans
- Purpose: Fetch station availability and free-floating vehicle positions from GBFS-compliant operators
- License: Varies per operator (CC0 default if unspecified)
- URL: https://github.com/MobilityData/gbfs/blob/master/data-licenses.md
- Commercial use: Varies; check each operator
- Attribution: Varies; check each operator
- Privacy: Per operator
- Country: Per operator
- End-user data exposure: Server-only
- DPA: Varies per operator
- Coverage: Global (per-operator)
- Env vars: None
- Self-hostable: No

### Felyx API — `https://felyx.frontend.fleetbird.eu/api/prod/v1.06/map/cars/`
- Data sent: No user data (fetches entire dataset, filtered server-side to bounding box)
- Data received: Vehicles with id, lat/lng, licence plate, fuel level, vehicle type, activation status
- Purpose: Fetch Felyx moped/e-scooter positions (Netherlands, Belgium)
- License: Proprietary (undocumented API)
- URL: https://felyx.com/terms/ (404 — company merged with Cooltra in 2024)
- Commercial use: Unknown
- Usage limits: Unknown
- Attribution: Unknown
- Privacy: https://cooltra.com/en/privacy-policy/
- Country: Netherlands / Spain (felyx Sharing B.V., Amsterdam; parent Cooltra Motosharing S.L.U., Barcelona)
- Privacy other: GDPR-compliant; DPO: Xavier Saula Adell; contact: gdpr@felyx.com or rgpd@cooltra.com
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Netherlands + Belgium
- Env vars: None
- Self-hostable: No

### GO Sharing API — `https://greenmo.core.gourban-mobility.com/front/vehicles`
- Data sent: Coordinates (latitude, longitude), search radius in meters
- Data received: Vehicles with id, lat/lng, battery level, vehicle type
- Purpose: Fetch GO Sharing scooters near the map center (primarily Netherlands)
- License: Proprietary (undocumented API)
- URL: https://go-sharing.com/terms-conditions/ (unreachable — acquired by BinBin in 2023)
- Commercial use: Unknown
- Usage limits: Unknown
- Attribution: Unknown
- Privacy: https://go-sharing.com/privacy-verklaring/
- Country: Netherlands / Turkey (GO Sharing B.V., Nieuwegein; acquired by BinBin / 1000 Yatirimlar Holding AS, Istanbul)
- Privacy other: GDPR for GO Sharing; Turkish KVKK for BinBin parent; standard contractual clauses for EEA-external transfers
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Primarily Netherlands
- Env vars: None
- Self-hostable: No

### Link/Superpedestrian API — `https://vehicles.linkyour.city/reservation-api/local-vehicles/`
- Data sent: Coordinates (latitude, longitude)
- Data received: Vehicles with id, lat/lng, battery level, vehicle type
- Purpose: Fetch Link e-scooters near the map center (multiple European cities). Note: company defunct since Dec 2023.
- License: Proprietary (undocumented API; company shut down Dec 2023)
- URL: https://superpedestrian.com/legal (403 — site no longer maintained)
- Commercial use: N/A — company defunct
- Other: European assets acquired by SURF Beyond, then Zeus Mobility
- Privacy: https://superpedestrian.com/at-eng/privacy-policy (may be inaccessible)
- Country: US / Netherlands (Superpedestrian, Inc., Delaware; EU entity: Superpedestrian Europe B.V., Amsterdam — now under Zeus Mobility, Ireland)
- End-user data exposure: Server-only
- DPA: Not applicable (company defunct)
- Coverage: Multiple European cities (defunct)
- Env vars: None
- Self-hostable: No

### Transitous/MOTIS API — `https://api.transitous.org`
- Data sent: Bounding box coordinates
- Data received: Rental stations with id, name, coordinates, form factors, availability counts; free-floating vehicles with coordinates, form factor, propulsion type
- Purpose: Fetch aggregated rental station/vehicle data from MOTIS transit platform
- License: AGPL-3.0-or-later (project); FOSS/non-profit use only for public API
- URL: https://transitous.org/api/
- Commercial use: No — not for commercial/for-profit use
- Usage limits: Best-effort; contact team before heavy use
- Attribution: User-Agent header with app name + version + contact info
- Privacy: https://transitous.org/privacy/
- Country: Germany (community project, no formal legal entity)
- Privacy other: Logs retained up to 2 days; request URLs may reveal location data
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: None
- Self-hostable: Yes — self-hosted MOTIS

### Nominatim Reverse Geocoding — `https://nominatim.openstreetmap.org/reverse`
- Data sent: Coordinates (latitude, longitude) of bounding box center, language preference
- Data received: Address with city/town/village name
- Purpose: Determine city name at viewport center to prioritize GBFS system probing (city-matching systems probed first)
- License: ODbL 1.0 (OSM data)
- URL: https://operations.osmfoundation.org/policies/nominatim/
- Commercial use: Yes, with caveats (access may be withdrawn)
- Usage limits: Max 1 req/sec; cache results
- Attribution: Yes — "Data © OpenStreetMap contributors, ODbL"
- Privacy: https://osmfoundation.org/wiki/Privacy_Policy
- Country: UK (OpenStreetMap Foundation)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: None
- Self-hostable: Yes — self-hosted Nominatim

## street-view-mapillary

### Mapillary Graph API — `https://graph.mapillary.com/images`
- License: CC BY-SA 4.0 (imagery); Proprietary (API service terms)
- Data sent: Bounding box coordinates (~1 km around click point), result limit
- Data received: Image IDs with point coordinates; nearest image ID returned for MapillaryJS viewer navigation
- Purpose: Find the nearest Mapillary street-level image to a clicked map location. Also proxies vector tiles (sequence lines + image points) via /api/mapillary/tiles/ to hide the token.
- URL: https://www.mapillary.com/terms
- Commercial use: Yes, restricted — no reselling, no real-time navigation
- Usage limits: No published limits; may throttle/revoke
- Attribution: Yes — Mapillary logo + link to homepage or image page
- Privacy: https://www.mapillary.com/privacy
- Country: Ireland / US (Meta Platforms)
- End-user data exposure: Mixed — image search is server-only, but the MapillaryJS viewer in the browser contacts graph.mapillary.com and fbcdn.net DIRECTLY; end-user IP is exposed to Meta when viewing street-level imagery. Vector tiles are proxied via BFF.
- DPA: Not available (Meta acts as independent controller)
- Coverage: Global
- Env vars: `MAPILLARY_TOKEN` — required (returns 503 if unset)
- Self-hostable: No (use Panoramax as open alternative)

## tool-measurement

No external API calls.

## tool-travel-time

### Valhalla Isochrone API — `https://valhalla1.openstreetmap.de/isochrone`

- License: MIT (software); fair-use demo server
- URL: https://github.com/valhalla/valhalla/blob/master/COPYING
- Commercial use: Yes (MIT software); demo server has fair-use expectations
- Usage limits: Demo server: ~1 req/user/sec, ~100 req/sec total; intended for testing, not production
- Attribution: Yes — MIT copyright notice (Valhalla contributors, Mapillary AB, Mapzen) + OSM ODbL attribution
- Privacy: https://www.fossgis.de/datenschutzerkl%C3%A4rung/
- Country: Germany (FOSSGIS e.V.; operates the demo server)
- Privacy other: Route requests saved in server logs; IP addresses collected but stated not attributable to individuals; no cookies; GDPR Art. 6(1)(f)
- Data sent: Center coordinates (latitude, longitude), travel mode, contour time thresholds in minutes
- Data received: GeoJSON isochrone polygons showing reachable area within specified time/distance thresholds
- Purpose: Visualize travel time reachability from a point on the map (isochrone polygons)
- End-user data exposure: Server-only — isochrone requests go through BFF /api/isochrone endpoint
- DPA: Not available (FOSSGIS e.V. demo server, no DPA offered)
- Coverage: Global (default public instance)
- Env vars: `VALHALLA_URL` — optional (default: `https://valhalla1.openstreetmap.de`)
- Self-hostable: Yes — Docker image (<https://github.com/nilsnolde/docker-valhalla>); already in project Docker Compose

## transit-bvg

### BVG HAFAS REST API — `https://v6.bvg.transport.rest`
- Data sent: Coordinates (latitude, longitude), search radius, stop ID, search query, origin and destination coordinates, departure/arrival time, bounding box (for vehicle radar)
- Data received: FPTF stops/departures/arrivals/journeys/trips/radar data for Berlin BVG network
- Purpose: Public transit data for Berlin (BVG) — stops, departures, journey planning, live vehicle positions
- License: ISC (software); no open license for data (unofficial HAFAS scraping)
- URL: https://github.com/public-transport/hafas-rest-api
- Commercial use: Yes (ISC software); data licensing is a gray area — HAFAS APIs are scraped without official approval
- Usage limits: None imposed by the library; upstream HAFAS endpoints may enforce their own
- Attribution: ISC copyright notice in distributed copies
- Privacy: -
- Country: Germany (Jannis Redmann, individual developer, Berlin)
- Privacy other: No privacy policy or impressum published for transport.rest endpoints; legally required under German TMG/TTDSG
- End-user data exposure: Server-only
- DPA: Not available (individual developer project, no legal entity)
- Coverage: Berlin, Germany (bbox 13.08-13.77E, 52.33-52.68N)
- Env vars: None
- Self-hostable: Partially — hafas-rest-api is self-hostable, but depends on upstream HAFAS backends

## transit-db-vendo

### DB Vendo API — via `db-vendo-client` package
- Data sent: Coordinates (latitude, longitude), search radius, stop ID, search query, origin and destination coordinates, departure/arrival time, trip ID
- Data received: FPTF-format stops, departures/arrivals with real-time delays, multi-leg journeys with stopovers, trip details with per-stop times/platforms/cancellations
- Purpose: Deutsche Bahn transit data — stop search, departure boards, journey planning, live trip tracking
- License: ISC (client software); no open license for data
- URL: https://github.com/public-transport/db-vendo-client
- Commercial use: Yes (ISC software); data licensing is a gray area
- Usage limits: None by library; upstream DB API may enforce limits
- Attribution: ISC copyright notice in distributed copies
- Privacy: -
- Country: Germany (Jannis Redmann, individual developer, Berlin)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Germany (bbox 5.87-15.04E, 47.27-55.06N)
- Env vars: `DB_USER_AGENT` — optional
- Self-hostable: Partially — db-vendo-client is open-source, but depends on upstream DB API

## transit-dynamic-registry

### JSDelivr Package Listing — `https://data.jsdelivr.com/v1/packages/gh/public-transport/transport-apis@HEAD`
- Data sent: No user data (static resource)
- Data received: JSON file tree; paths matching data/**/*.json extracted as provider definition files
- Purpose: Discover transport API definition files in the dynamic transit registry (primary source)
- License: MIT (service)
- URL: https://www.jsdelivr.com/terms/terms-of-use
- Commercial use: Yes, free for both personal and commercial use
- Usage limits: No bandwidth/request limits; 100+ RPM sustained on data API should be discussed first
- Attribution: Not required
- Privacy: https://www.jsdelivr.com/terms/privacy-policy
- Country: UK (Volentio JSD Limited, Barnet, England)
- Privacy other: No cookies; IPs collected but never associated with specific users; DPA available; non-aggregated data deleted after analysis
- End-user data exposure: Server-only
- DPA: Available — <https://www.jsdelivr.com/documents/data-processing-agreement.pdf>
- Coverage: N/A (registry metadata, not transit data)
- Env vars: `GITHUB_TOKEN` — optional (increases rate limits)
- Self-hostable: No

### JSDelivr CDN — `https://cdn.jsdelivr.net/gh/public-transport/transport-apis@HEAD`
- Data sent: File path within the transport-apis repository
- Data received: Provider config: name, type (protocol), coverage area (GeoJSON), endpoint URL, auth config, supported products/languages
- Purpose: Load configuration for each dynamically-discovered transit API provider
- License: MIT (service)
- URL: https://www.jsdelivr.com/terms/terms-of-use
- Commercial use: Yes
- Usage limits: No bandwidth/request limits
- Attribution: Not required
- Privacy: https://www.jsdelivr.com/terms/privacy-policy
- Country: UK (Volentio JSD Limited)
- End-user data exposure: Server-only
- DPA: Available — <https://www.jsdelivr.com/documents/data-processing-agreement.pdf>
- Coverage: N/A (registry metadata)
- Env vars: None
- Self-hostable: No

### GitHub Tree API — `https://api.github.com/repos/public-transport/transport-apis/git/trees/v1`
- Data sent: No user data (static resource)
- Data received: Git tree with all file paths; filtered to data/**/*.json blobs
- Purpose: Fallback file listing when JSDelivr is unavailable
- License: Proprietary (GitHub ToS)
- URL: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
- Commercial use: Per individual repo license
- Usage limits: 5,000 req/hr authenticated
- Attribution: Per repo license
- Privacy: https://docs.github.com/site-policy/privacy-policies/github-privacy-statement
- Country: US (GitHub, Inc. / Microsoft, San Francisco; EU: GitHub B.V., Amsterdam)
- Privacy other: GDPR-compliant; DPA available; collects IP addresses, device info, session data
- End-user data exposure: Server-only
- DPA: Available — <https://github.com/customer-terms/github-data-protection-agreement> (applies to Enterprise; free tier covered by standard ToS)
- Coverage: N/A (fallback registry source)
- Env vars: `GITHUB_TOKEN` — optional
- Self-hostable: No

### GitHub Raw Content — `https://raw.githubusercontent.com/public-transport/transport-apis/v1`
- Data sent: File path within the transport-apis repository
- Data received: Same provider config JSON as JSDelivr CDN
- Purpose: Fallback content fetching when JSDelivr is unavailable
- License: Proprietary (GitHub ToS)
- URL: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
- Commercial use: Per individual repo license
- Usage limits: 5,000 req/hr authenticated
- Privacy: https://docs.github.com/site-policy/privacy-policies/github-privacy-statement
- Country: US (GitHub / Microsoft)
- End-user data exposure: Server-only
- DPA: Available — <https://github.com/customer-terms/github-data-protection-agreement>
- Coverage: N/A (fallback registry source)
- Env vars: `GITHUB_TOKEN` — optional
- Self-hostable: No

## transit-gtfs-local

No external API calls (queries local PostGIS database).

## transit-hafas

### DB HAFAS REST API — `https://v6.db.transport.rest`
- Data sent: Coordinates (latitude, longitude), search radius, stop ID, search query, origin and destination coordinates, departure/arrival time, trip ID
- Data received: FPTF stops, departures/arrivals with delays/remarks, multi-leg journeys with GeoJSON polylines and stopovers, trip details
- Purpose: Deutsche Bahn transit data via community HAFAS REST wrapper
- License: ISC (software); no open license for data (unofficial HAFAS scraping)
- URL: https://github.com/public-transport/hafas-rest-api
- Commercial use: Yes (ISC software); data licensing is a gray area
- Usage limits: None by library; upstream HAFAS may enforce limits
- Attribution: ISC copyright notice in distributed copies
- Privacy: -
- Country: Germany (Jannis Redmann, individual, Berlin)
- Privacy other: No privacy policy published for *.transport.rest
- End-user data exposure: Server-only
- DPA: Not available (individual developer project, no legal entity)
- Coverage: Germany
- Env vars: None
- Self-hostable: Partially — hafas-rest-api is self-hostable, but depends on upstream HAFAS backends

### VBB HAFAS REST API — `https://v6.vbb.transport.rest`
- Data sent: Coordinates (latitude, longitude), search radius, stop ID, search query, origin and destination coordinates, departure/arrival time, trip ID, bounding box (for vehicle radar)
- Data received: Same FPTF data plus live vehicle positions (movements with tripId, coordinates, bearing, speed, line name)
- Purpose: Berlin-Brandenburg (VBB) transit data — stops, departures, journey planning, live vehicle radar
- License: ISC (software); no open license for data (unofficial HAFAS scraping)
- URL: https://github.com/public-transport/hafas-rest-api
- Commercial use: Yes (ISC software); data: gray area
- Attribution: ISC copyright notice
- Privacy: -
- Country: Germany (Jannis Redmann, individual)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Berlin-Brandenburg, Germany
- Env vars: None
- Self-hostable: Partially

### BVG HAFAS REST API — `https://v6.bvg.transport.rest`
- Data sent: Coordinates (latitude, longitude), search radius, stop ID, search query, origin and destination coordinates, departure/arrival time, bounding box (for vehicle radar)
- Data received: FPTF stops/departures/arrivals/journeys/trips/radar data for Berlin BVG network
- Purpose: Public transit data for Berlin (BVG) — stops, departures, journey planning, live vehicle positions
- License: ISC (software); no open license for data (unofficial HAFAS scraping)
- URL: https://github.com/public-transport/hafas-rest-api
- Commercial use: Yes (ISC software); data: gray area
- Attribution: ISC copyright notice
- Privacy: -
- Country: Germany (Jannis Redmann, individual)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Berlin, Germany
- Env vars: None
- Self-hostable: Partially

## transit-irail

### iRail Stations API — `https://api.irail.be/stations/`
- Data sent: Language preference
- Data received: All Belgian railway stations with id, name, longitude (locationX), latitude (locationY)
- Purpose: Load full Belgian station list for nearby lookup, name search, and journey station snapping
- License: AGPL-3.0 (API software); CC0 (log data)
- URL: https://hello.irail.be/api/
- Commercial use: Likely yes — CC0 data; AGPL-3.0 software
- Usage limits: 3 req/sec per IP (5 burst); must send User-Agent header
- Attribution: Encouraged but not required (CC0); recommended User-Agent: "appname/version (website; email)"
- Privacy: -
- Country: Belgium (Open Knowledge Belgium VZW; community project)
- Privacy other: No dedicated privacy policy found
- End-user data exposure: Server-only
- DPA: Not available (community project under Open Knowledge Belgium)
- Coverage: Belgium
- Env vars: None
- Self-hostable: No

### iRail Liveboard API — `https://api.irail.be/liveboard/`
- Data sent: Stop ID, departure/arrival mode, language preference
- Data received: Departures/arrivals with Unix timestamp, delay (seconds), vehicle ID, station info, platform, cancelled flag, occupancy
- Purpose: Real-time departure/arrival boards for Belgian railway stations
- License: AGPL-3.0 (API software); CC0 (log data)
- URL: https://hello.irail.be/api/
- Commercial use: Likely yes
- Usage limits: 3 req/sec per IP (5 burst)
- Attribution: Encouraged; User-Agent recommended
- Privacy: -
- Country: Belgium
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Belgium
- Env vars: None
- Self-hostable: No

### iRail Vehicle API — `https://api.irail.be/vehicle/`
- Data sent: Vehicle ID, language preference
- Data received: Full stop sequence with scheduled/actual times, delay, platform, cancelled flag, departure status
- Purpose: Get stop-by-stop journey for a specific Belgian train (vehicle journey detail)
- License: AGPL-3.0 (API software); CC0 (log data)
- URL: https://hello.irail.be/api/
- Commercial use: Likely yes
- Usage limits: 3 req/sec per IP (5 burst)
- Privacy: -
- Country: Belgium
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Belgium
- Env vars: None
- Self-hostable: No

### iRail Connections API — `https://api.irail.be/connections/`
- Data sent: Origin and destination station IDs, date, time, departure/arrival mode, number of results
- Data received: Connections with departure/arrival times, via stops, duration, vehicle info, direction
- Purpose: Plan rail journeys between two Belgian stations
- License: AGPL-3.0 (API software); CC0 (log data)
- URL: https://hello.irail.be/api/
- Commercial use: Likely yes
- Usage limits: 3 req/sec per IP (5 burst)
- Privacy: -
- Country: Belgium
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Belgium
- Env vars: None
- Self-hostable: No

## transit-mbta

### MBTA Stops API — `https://api-v3.mbta.com/stops`
- Data sent: Coordinates (latitude, longitude), search radius
- Data received: JSON:API stops with id, name, lat/lng, vehicle_type, platform_code, parent station
- Purpose: Find transit stops near a location in the MBTA (Boston) network
- License: Proprietary (MassDOT Developers License Agreement)
- URL: https://www.mbta.com/developers/v3-api
- Commercial use: Yes (broadly permissive government license)
- Usage limits: 1,000 req/min with API key (free); lower limits without key
- Attribution: Yes — per MassDOT license agreement (see PDF)
- Privacy: https://www.mbta.com/policies/privacy-policy
- Country: US (MBTA, Massachusetts state government agency)
- End-user data exposure: Server-only
- DPA: Not applicable (US government agency)
- Coverage: Boston metro area, US (bbox -71.9 to -69.9E, 41.3-42.9N)
- Env vars: `MBTA_API_KEY` — optional (lower rate limits without)
- Self-hostable: No

### MBTA Predictions API — `https://api-v3.mbta.com/predictions`
- Data sent: Stop ID
- Data received: Predictions with departure/arrival times (scheduled + real-time), headsign, route info (name, type, color), schedule relationship
- Purpose: Real-time departure predictions with delay calculation for MBTA stops
- License: Proprietary (MassDOT Developers License Agreement)
- URL: https://www.mbta.com/developers/v3-api
- Commercial use: Yes
- Usage limits: 1,000 req/min
- Privacy: https://www.mbta.com/policies/privacy-policy
- Country: US (MBTA)
- End-user data exposure: Server-only
- DPA: Not applicable (US government)
- Coverage: Boston metro, US
- Env vars: `MBTA_API_KEY` — optional
- Self-hostable: No

### MBTA Alerts API — `https://api-v3.mbta.com/alerts`
- Data sent: Optional stop ID, optional route ID
- Data received: Alerts with severity, effect, header, description, informed entities (routes/stops), active periods
- Purpose: Service disruption alerts for MBTA stops and routes
- License: Proprietary (MassDOT Developers License Agreement)
- URL: https://www.mbta.com/developers/v3-api
- Commercial use: Yes
- Usage limits: 1,000 req/min
- Privacy: https://www.mbta.com/policies/privacy-policy
- Country: US (MBTA)
- End-user data exposure: Server-only
- DPA: Not applicable (US government)
- Coverage: Boston metro, US
- Env vars: `MBTA_API_KEY` — optional
- Self-hostable: No

### MBTA Vehicles API — `https://api-v3.mbta.com/vehicles`
- Data sent: Route ID
- Data received: Vehicle positions with lat/lng, bearing, speed, label, current stop sequence, update timestamp
- Purpose: Live vehicle positions for a given MBTA route
- License: Proprietary (MassDOT Developers License Agreement)
- URL: https://www.mbta.com/developers/v3-api
- Commercial use: Yes
- Usage limits: 1,000 req/min
- Privacy: https://www.mbta.com/policies/privacy-policy
- Country: US (MBTA)
- End-user data exposure: Server-only
- DPA: Not applicable (US government)
- Coverage: Boston metro, US
- Env vars: `MBTA_API_KEY` — optional
- Self-hostable: No

### MBTA Shapes API — `https://api-v3.mbta.com/shapes`
- Data sent: Route ID
- Data received: Encoded polylines with priority ranking
- Purpose: Get geographic shape/path of an MBTA route
- License: Proprietary (MassDOT Developers License Agreement)
- URL: https://www.mbta.com/developers/v3-api
- Commercial use: Yes
- Usage limits: 1,000 req/min
- Privacy: https://www.mbta.com/policies/privacy-policy
- Country: US (MBTA)
- End-user data exposure: Server-only
- DPA: Not applicable (US government)
- Coverage: Boston metro, US
- Env vars: `MBTA_API_KEY` — optional
- Self-hostable: No

### MBTA Routes API — `https://api-v3.mbta.com/routes`
- Data sent: Route ID
- Data received: Route metadata: short/long name, type, color, text color. Shape geometry fetched in parallel.
- Purpose: Fetch MBTA route details and shape geometry
- License: Proprietary (MassDOT Developers License Agreement)
- URL: https://www.mbta.com/developers/v3-api
- Commercial use: Yes
- Usage limits: 1,000 req/min
- Privacy: https://www.mbta.com/policies/privacy-policy
- Country: US (MBTA)
- End-user data exposure: Server-only
- DPA: Not applicable (US government)
- Coverage: Boston metro, US
- Env vars: `MBTA_API_KEY` — optional
- Self-hostable: No

### MBTA Facilities API — `https://api-v3.mbta.com/facilities`
- Data sent: Stop ID, facility type filter (elevator, escalator)
- Data received: Facilities with type, names, accessibility properties
- Purpose: Get elevator/escalator facilities at an MBTA stop (accessibility info)
- License: Proprietary (MassDOT Developers License Agreement)
- URL: https://www.mbta.com/developers/v3-api
- Commercial use: Yes
- Usage limits: 1,000 req/min
- Privacy: https://www.mbta.com/policies/privacy-policy
- Country: US (MBTA)
- End-user data exposure: Server-only
- DPA: Not applicable (US government)
- Coverage: Boston metro, US
- Env vars: `MBTA_API_KEY` — optional
- Self-hostable: No

## transit-motis

### Transitous (Cloud MOTIS) — `https://api.transitous.org`
- Data sent: Stop ID, time window, search text, origin and destination coordinates, departure/arrival time, bounding box (for vehicle positions), trip ID
- Data received: Stops with modes, departures/arrivals with real-time delays/cancellations/tracks, multi-modal itineraries with fares and leg geometry, vehicle positions, trip stop sequences
- Purpose: Transit stop search, departure boards, journey planning with fares, live vehicle radar, trip tracking
- License: AGPL-3.0-or-later (project); FOSS/non-profit use only for public API
- URL: https://transitous.org/api/
- Commercial use: No — not for commercial/for-profit use
- Usage limits: Best-effort; contact team before heavy use
- Attribution: User-Agent header (app name + version + contact info)
- Privacy: https://transitous.org/privacy/
- Country: Germany (community project)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global (Transitous aggregates 1800+ GTFS feeds from 55+ countries)
- Env vars: `TRANSITOUS_URL` — optional; `TRANSITOUS_USER_AGENT` — optional
- Self-hostable: Yes — MOTIS Docker image (<https://github.com/motis-project/motis>); already in project Docker Compose

### Local MOTIS — `http://localhost:8081`
- Data sent: Stop ID, time window, search text, origin and destination coordinates, departure/arrival time, bounding box (for vehicle positions), trip ID
- Data received: Same data structure — stops, departures, itineraries, vehicle positions, trip details
- Purpose: Self-hosted MOTIS instance for transit data (same API as Transitous)
- License: MIT (self-hosted software)
- URL: https://github.com/motis-project/motis
- Commercial use: Yes, unrestricted
- Usage limits: N/A (self-hosted)
- Attribution: MIT copyright notice in distributed copies
- Privacy: -
- Country: Germany (TU Darmstadt / triptix GmbH)
- End-user data exposure: Server-only (self-hosted)
- DPA: Not applicable (self-hosted)
- Coverage: Configurable (depends on loaded GTFS/OSM data)
- Env vars: `MOTIS_URL` — optional (default: `http://localhost:8081`)
- Self-hostable: Yes — already self-hosted

## transit-opentransportdata-ch

### Swiss Open Journey Planner (OJP) — `https://api.opentransportdata.swiss/ojp20`
- Data sent: Search text, stop identifiers, nearby-search coordinates, trip origin/destination coordinates, departure/arrival time, request language, requestor id
- Data received: Stops, departures/arrivals, trip itineraries, trip detail and geometry, service metadata, occupancy and formation references where available
- Purpose: Official Swiss transit stop search, nearby stops, live boards, route discovery, trip planning, trip geometry and trip detail
- License: Open data platform mobility Switzerland terms of use
- URL: https://opentransportdata.swiss/en/terms-of-use/
- Commercial use: Conditional — official terms permit use by companies and publication in applications, but the grant is platform-specific rather than a standard OSS/open-data license
- Usage limits: API key required; official limits apply and backend caching is mandatory
- Attribution: Source: opentransportdata.swiss
- Privacy: https://opentransportdata.swiss/en/privacy-notice/
- Country: Switzerland (Open Data Mobilität Schweiz / SKI on behalf of the Swiss Federal Office of Transport)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Switzerland
- Env vars: None directly; configure shared secret `opentransportdata-ch-api-key`
- Self-hostable: No

### Swiss GTFS Static Timetable — `https://opentransportdata.swiss/en/cookbook/timetable-cookbook/gtfs/`
- Data sent: Dataset page fetches and file downloads only
- Data received: Official Swiss GTFS static timetable, including routes, trips, stop times, shapes and original Swiss stop identifiers
- Purpose: Back Swiss `getRoute()` / `getRouteStops()` enrichment with durable stop sequences, route colors and line geometry when the official feed is available
- License: Open data platform mobility Switzerland terms of use
- URL: https://opentransportdata.swiss/en/cookbook/timetable-cookbook/gtfs/
- Commercial use: Conditional
- Usage limits: Large file-based open-data download; refresh on source timetable updates and cache/import server-side
- Attribution: Source: opentransportdata.swiss
- Privacy: https://opentransportdata.swiss/en/privacy-notice/
- Country: Switzerland
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Switzerland
- Env vars: None
- Self-hostable: No

### Swiss GTFS Realtime Service Alerts — `https://api.opentransportdata.swiss/la/gtfs-sa`
- Data sent: Authenticated feed request only (no user coordinates or ids beyond the API key)
- Data received: Nationwide GTFS-RT service alerts with affected stops/routes and active periods
- Purpose: Swiss stop-level, route-level and bbox-level transit alerts
- License: Open data platform mobility Switzerland terms of use
- URL: https://opentransportdata.swiss/en/cookbook/event-cookbook/gtfs-sa/
- Commercial use: Conditional
- Usage limits: API key required; official docs describe stricter polling limits than generic platform limits
- Attribution: Source: opentransportdata.swiss
- Privacy: https://opentransportdata.swiss/en/privacy-notice/
- Country: Switzerland
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Switzerland
- Env vars: None directly; configure shared secret `opentransportdata-ch-api-key`
- Self-hostable: No

### Swiss GTFS Realtime Trip Updates — `https://api.opentransportdata.swiss/la/gtfs-rt`
- Data sent: Authenticated feed request only (no user coordinates or ids beyond the API key)
- Data received: Nationwide GTFS-RT trip updates for Swiss realtime-capable operators, with stop-time delays/cancellations
- Purpose: Conservative stop-board overlay for Swiss departures/arrivals when the GTFS-RT stop and time match the OJP board entry
- License: Open data platform mobility Switzerland terms of use
- URL: https://opentransportdata.swiss/en/cookbook/realtime-prediction-cookbook/gtfs-rt/
- Commercial use: Conditional
- Usage limits: API key required; official docs state two requests per minute per key and 30 second cache cadence
- Attribution: Source: opentransportdata.swiss
- Privacy: https://opentransportdata.swiss/en/privacy-notice/
- Country: Switzerland
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Switzerland
- Env vars: None directly; configure shared secret `opentransportdata-ch-api-key`
- Self-hostable: No

### Swiss SIRI Situation Exchange — `https://api.opentransportdata.swiss/la/siri-sx`
- Data sent: Authenticated feed request only (no user coordinates or ids beyond the API key)
- Data received: Nationwide planned and unplanned SIRI-SX incident messages with affected lines/operators/stops and validity windows
- Purpose: Merge Swiss event/situation data into route, stop and bbox alert surfaces
- License: Open data platform mobility Switzerland terms of use
- URL: https://opentransportdata.swiss/en/cookbook/event-cookbook/siri-sx/
- Commercial use: Conditional
- Usage limits: API key required; use `siri-sx-unplanned` for frequent polling and `siri-sx` only occasionally for the full/planned feed
- Attribution: Source: opentransportdata.swiss
- Privacy: https://opentransportdata.swiss/en/privacy-notice/
- Country: Switzerland
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Switzerland
- Env vars: None directly; configure shared secret `opentransportdata-ch-api-key`
- Self-hostable: No

### Swiss OJP Fare — `https://api.opentransportdata.swiss/ojpfare`
- Data sent: Serialized OJP trip request fragments for fare lookup, request language, requestor id
- Data received: Fare products, authorities, ticket prices, classes and transfer bundles
- Purpose: Populate `TripPlan.fare` for Swiss OJP itineraries
- License: Open data platform mobility Switzerland terms of use
- URL: https://opentransportdata.swiss/en/cookbook/open-journey-planner-ojp/ojp-fare/
- Commercial use: Conditional
- Usage limits: API key required; backend caching strongly recommended
- Attribution: Source: opentransportdata.swiss
- Privacy: https://opentransportdata.swiss/en/privacy-notice/
- Country: Switzerland
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Switzerland
- Env vars: None directly; configure shared secret `opentransportdata-ch-api-key`
- Self-hostable: No

### Swiss Train Formation Service — `https://api.opentransportdata.swiss/formation`
- Data sent: Authenticated query with rail operator code (`evu`), operation date and train number
- Data received: Train composition details, short formation strings, vehicle counts, seat counts and coach attributes where the operator publishes them
- Purpose: Enrich Swiss `VehicleJourney` responses with coach composition metadata beyond the OJP formation references
- License: Open data platform mobility Switzerland terms of use
- URL: https://opentransportdata.swiss/en/cookbook/realtime-prediction-cookbook/formationsdaten/
- Commercial use: Conditional
- Usage limits: API key required; service only returns supported rail operators and today/+3-day journeys where realtime formation data is available
- Attribution: Source: opentransportdata.swiss
- Privacy: https://opentransportdata.swiss/en/privacy-notice/
- Country: Switzerland
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Switzerland
- Env vars: None directly; configure shared secret `opentransportdata-ch-api-key`
- Self-hostable: No

### Swiss Occupancy Forecast Dataset — `https://data.opentransportdata.swiss/en/dataset/occupancy-forecast-json-dataset`
- Data sent: Dataset page fetches and ZIP download requests only
- Data received: Per-day, per-operator JSON occupancy forecasts with train, section, stop and fare-class occupancy levels
- Purpose: Fill Swiss departure, itinerary-leg and `VehicleJourney` occupancy when OJP does not carry realtime occupancy directly
- License: Open data platform mobility Switzerland terms of use
- URL: https://data.opentransportdata.swiss/en/dataset/occupancy-forecast-json-dataset
- Commercial use: Conditional
- Usage limits: Large batch ZIP; download/cache server-side and read only the required operator/day entry
- Attribution: Source: opentransportdata.swiss
- Privacy: https://opentransportdata.swiss/en/privacy-notice/
- Country: Switzerland
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Switzerland
- Env vars: None
- Self-hostable: No

### Swiss Service and Traffic Point Master Data — `https://data.opentransportdata.swiss/`
- Data sent: Dataset page fetches and file downloads only
- Data received: Service points, traffic points, accessibility, reference points, contact points, toilets, parking lots and relations
- Purpose: Swiss stop identity crosswalks, platform hierarchy, accessibility, amenities and station infrastructure enrichment
- License: Open data platform mobility Switzerland terms of use
- URL: https://opentransportdata.swiss/en/cookbook/masterdata-cookbook/
- Commercial use: Conditional
- Usage limits: File-based open-data downloads; refresh regularly to stay aligned with source updates
- Attribution: Source: opentransportdata.swiss
- Privacy: https://opentransportdata.swiss/en/privacy-notice/
- Country: Switzerland
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Switzerland
- Env vars: None
- Self-hostable: No

### Swiss Business Organisation Realtime/Event Metadata — `https://data.opentransportdata.swiss/`
- Data sent: CSV download requests only
- Data received: Business-organisation names, abbreviations, realtime capability flags, SIRI participant refs and operator-number crosswalks
- Purpose: Map Swiss operator refs to human-readable branding and link OJP/SIRI/formations to the same operator metadata
- License: Open data platform mobility Switzerland terms of use
- URL: https://data.opentransportdata.swiss/en/dataset/go-realtime
- Commercial use: Conditional
- Usage limits: File-based open-data downloads; current CKAN catalog notes that these legacy datasets are scheduled to be replaced after June 30, 2026
- Attribution: Source: opentransportdata.swiss
- Privacy: https://opentransportdata.swiss/en/privacy-notice/
- Country: Switzerland
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Switzerland
- Env vars: None
- Self-hostable: No

### OpenStreetMap Geometry Used by Swiss OJP Outputs
- Data sent: None directly from this integration; OSM attribution applies where Swiss OJP geometry is OSM-backed
- Data received: Derived routing geometry via Swiss OJP responses
- Purpose: Required attribution for path/geometry outputs backed by OpenStreetMap
- License: ODbL 1.0
- URL: https://www.openstreetmap.org/copyright
- Commercial use: Yes
- Usage limits: N/A
- Attribution: Yes — "© OpenStreetMap contributors"
- Privacy: https://osmfoundation.org/wiki/Privacy_Policy
- Country: UK (OpenStreetMap Foundation)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global, but only relevant here where Swiss OJP geometry uses OSM
- Env vars: None
- Self-hostable: Yes — self-hosted OSM stacks are possible, but this integration consumes geometry through Swiss OJP

## transit-otp

### OpenTripPlanner Plan API — `http://localhost:8090/otp/routers/default/plan`
- Data sent: Origin and destination coordinates, time, date, travel mode, number of itineraries, optional arrive-by flag
- Data received: Itineraries with duration, start/end times, transfers, walk distance, legs with mode, route info, encoded polyline geometry, intermediate stops
- Purpose: Multi-modal transit trip planning via self-hosted OpenTripPlanner
- License: LGPL v3+ (self-hosted software)
- URL: https://github.com/opentripplanner/OpenTripPlanner/blob/dev-2.x/LICENSE
- Commercial use: Yes — LGPL allows commercial use; modifications to OTP source must be released under LGPL
- Usage limits: N/A (self-hosted)
- Attribution: Preserve copyright notices and include LGPL v3 license text
- Privacy: -
- Country: US (Software Freedom Conservancy, 501(c)(3), Brooklyn, NY; originally TriMet, Portland)
- Privacy other: Self-hosted — no external data collection; privacy responsibility lies with the operator
- End-user data exposure: Server-only (self-hosted)
- DPA: Not applicable (self-hosted software)
- Coverage: Configurable (depends on loaded GTFS/OSM data)
- Env vars: `OTP_URL` — optional (default: `http://localhost:8090`)
- Self-hostable: Yes — already self-hosted; Docker image at <https://hub.docker.com/r/opentripplanner/opentripplanner>

## transit-overpass

### Overpass API — `https://overpass-api.de/api/interpreter`
- License: ODbL 1.0 (OSM data)
- Data sent: Bounding box coordinates
- Data received: OSM nodes with name, ref, transport mode tags (train, tram, bus, subway, ferry, light_rail, monorail, gondola, funicular, aerialway)
- Purpose: Fallback transit stop discovery using OpenStreetMap data when no other provider covers the area
- URL: https://www.openstreetmap.org/copyright
- Commercial use: Yes
- Attribution: Yes — "© OpenStreetMap contributors"
- Privacy: https://osmfoundation.org/wiki/Privacy_Policy
- Country: UK (OpenStreetMap Foundation)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global (fallback when no other transit provider covers the area)
- Env vars: None
- Self-hostable: Yes — self-hosted Overpass

## transit-ris-routing

### DB RIS Stations API — `https://apis.deutschebahn.com/db/apis/ris-stations/v1`
- License: Proprietary (custom bilateral license per API product)
- Data sent: Coordinates (latitude, longitude), search radius
- Data received: Stop places with EVA number, names, coordinates, available transports
- Purpose: Resolve coordinates to nearest DB station for journey planning (used internally by the routing provider)
- URL: https://developers.deutschebahn.com/db-api-marketplace/apis/nutzungsbedingungen
- Commercial use: Yes, with individual license agreement
- Usage limits: Set per API product
- Privacy: https://developers.deutschebahn.com/db-api-marketplace/apis/privacypolicy
- Country: Germany (Deutsche Bahn AG)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Germany
- Env vars: `DB_RIS_CLIENT_ID`, `DB_RIS_API_KEY` — required pair
- Self-hostable: No

### DB RIS Routing API — `https://apis.deutschebahn.com/db/apis/ris-routing/v2`
- License: Proprietary (custom bilateral license per API product)
- URL: https://developers.deutschebahn.com/db-api-marketplace/apis/nutzungsbedingungen
- Commercial use: Yes, with individual license agreement
- Usage limits: Set per API product
- Privacy: https://developers.deutschebahn.com/db-api-marketplace/apis/privacypolicy
- Country: Germany (Deutsche Bahn AG)
- Data sent: Origin and destination coordinates, departure/arrival time, language preference
- Data received: Trips with legs (WALK/JOURNEY/CONNECT), transport category/line/number/direction, Google-encoded polylines, per-stop scheduled/actual times and platforms
- Purpose: Deutsche Bahn's official journey planner for multi-modal transit routing in Germany
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Germany
- Env vars: `DB_RIS_CLIENT_ID`, `DB_RIS_API_KEY` — required pair
- Self-hostable: No

### DB RIS Maps API — `https://apis.deutschebahn.com/db/apis/ris-maps/v2`
- License: Proprietary (custom bilateral license per API product)
- URL: https://developers.deutschebahn.com/db-api-marketplace/apis/nutzungsbedingungen
- Commercial use: Yes, with individual license agreement
- Usage limits: Set per API product
- Privacy: https://developers.deutschebahn.com/db-api-marketplace/apis/privacypolicy
- Country: Germany (Deutsche Bahn AG)
- Data sent: Not directly called by this integration
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Germany
- Env vars: None (uses shared credentials)
- Self-hostable: No

### DB RIS Transports API — `https://apis.deutschebahn.com/db/apis/ris-transports/v3`
- License: Proprietary (custom bilateral license per API product)
- URL: https://developers.deutschebahn.com/db-api-marketplace/apis/nutzungsbedingungen
- Commercial use: Yes, with individual license agreement
- Usage limits: Set per API product
- Privacy: https://developers.deutschebahn.com/db-api-marketplace/apis/privacypolicy
- Country: Germany (Deutsche Bahn AG)
- Data sent: Not directly called by this integration
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Germany
- Env vars: None (uses shared credentials)
- Self-hostable: No

## transit-tfl

### TfL StopPoint API — `https://api.tfl.gov.uk/StopPoint`
- Data sent: Coordinates (latitude, longitude), search radius, stop type filter
- Data received: Stop points with NaPTAN ID, name, coordinates, modes (tube/dlr/rail/bus/tram/ferry), platform code
- Purpose: Find transit stops near a location in the London TfL network
- License: Proprietary (Open Government Licence v2 with TfL amendments)
- URL: https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service
- Commercial use: Yes, explicitly allowed
- Usage limits: Max 500 calls/min per data feed; TfL may throttle if service degrades
- Attribution: Yes — "Powered by TfL Open Data" AND "Contains OS data © Crown copyright and database rights 2016"
- Other: Automated extraction from Oyster/Congestion Charging/Santander Cycles requires separate written agreement
- Privacy: https://tfl.gov.uk/corporate/privacy-and-cookies/privacy-and-data-protection-policy
- Country: UK (Transport for London, statutory corporation)
- Privacy other: UK GDPR and Data Protection Act 2018 compliant; DPO: DPO@tfl.gov.uk; restricts data transfers outside UK/EEA
- End-user data exposure: Server-only
- DPA: Not available (TfL acts as controller; UK government body)
- Coverage: London, UK (bbox -0.51 to 0.33E, 51.28-51.69N)
- Env vars: `TFL_API_KEY` — optional (lower rate limits without)
- Self-hostable: No

### TfL Line API — `https://api.tfl.gov.uk/Line`
- Data sent: Line ID or transport mode filter
- Data received: Line statuses with severity/description/reason; route stop sequences with ordered stops
- Purpose: Get disruption status and stop sequences for TfL lines
- License: Proprietary (Open Government Licence v2 with TfL amendments)
- URL: https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service
- Commercial use: Yes
- Usage limits: Max 500 calls/min per data feed
- Attribution: Yes — "Powered by TfL Open Data" + OS data copyright notice
- Privacy: https://tfl.gov.uk/corporate/privacy-and-cookies/privacy-and-data-protection-policy
- Country: UK (Transport for London)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: London, UK
- Env vars: `TFL_API_KEY` — optional
- Self-hostable: No

## transit-transitland

### Transitland Stops API — `https://transit.land/api/v2/rest/stops`
- Data sent: Bounding box coordinates, optional route type filter
- Data received: Stops with onestop_id, name, coordinates, route_stops (with route types), platform code, parent station
- Purpose: Find transit stops in a bounding box via Transitland aggregator
- License: Proprietary (Interline Technologies ToS)
- URL: https://www.transit.land/terms
- Commercial use: Yes, subject to Interline ToS; enterprise terms available
- Usage limits: Per API plan tier (free vs paid vs enterprise)
- Attribution: Yes — "Transitland" name/logo + link to transit.land/terms, clearly visible to end users
- Other: Data licensing varies per source feed; consumer must verify per-feed licenses
- Privacy: https://www.interline.io/legal/privacy/
- Country: US (Interline Technologies LLC, Alameda, California)
- Privacy other: Hosted on AWS and Google Cloud; no GDPR provisions mentioned
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: `TRANSIT_LAND_API_KEY` — optional (lower rate limits without)
- Self-hostable: Partially — transitland-lib is open-source GPLv3, but full API requires Interline infrastructure

### Transitland Routes API — `https://transit.land/api/v2/rest/routes`
- Data sent: Bounding box coordinates or stop ID
- Data received: Routes with onestop_id, short/long name, type, color, operator/agency name, geometry
- Purpose: Find transit routes by area or serving stop
- License: Proprietary (Interline Technologies ToS)
- URL: https://www.transit.land/terms
- Commercial use: Yes
- Attribution: Yes — Transitland name/logo + link
- Privacy: https://www.interline.io/legal/privacy/
- Country: US (Interline Technologies LLC)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: `TRANSIT_LAND_API_KEY` — optional
- Self-hostable: Partially

### Transitland Departures API — `https://transit.land/api/v2/rest/stops/{onestop_id}/departures`
- Data sent: Stop ID, time window (seconds)
- Data received: Departures with scheduled/actual times, trip headsign, route info (name, type, color), platform code
- Purpose: Get upcoming departures from a Transitland stop
- License: Proprietary (Interline Technologies ToS)
- URL: https://www.transit.land/terms
- Commercial use: Yes
- Attribution: Yes — Transitland name/logo + link
- Privacy: https://www.interline.io/legal/privacy/
- Country: US (Interline Technologies LLC)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: `TRANSIT_LAND_API_KEY` — optional
- Self-hostable: Partially

## transit-vbb

### VBB HAFAS REST API — `https://v6.vbb.transport.rest`

- License: ISC (software); no open license for data (unofficial HAFAS scraping)
- URL: https://github.com/public-transport/hafas-rest-api
- Commercial use: Yes (ISC software); data licensing is a gray area — HAFAS APIs are scraped without official approval
- Usage limits: None imposed by the library; upstream HAFAS endpoints may enforce their own
- Attribution: ISC copyright notice in distributed copies
- Privacy: -
- Country: Germany (Jannis Redmann, individual developer, Berlin)
- Privacy other: No privacy policy or impressum published for transport.rest endpoints; legally required under German TMG/TTDSG
- Data sent: Coordinates (latitude, longitude), search radius, stop ID, search query, origin and destination coordinates, departure/arrival time, trip ID, bounding box (for vehicle radar)
- Data received: FPTF stops, departures/arrivals with delays/remarks, journeys with GeoJSON polylines and stopovers, live vehicle positions (movements with tripId, coordinates, bearing, speed, line name)
- Purpose: Berlin-Brandenburg (VBB) transit data — stops, departures, journey planning, live vehicle radar
- End-user data exposure: Server-only
- DPA: Not available (individual developer project, no legal entity)
- Coverage: Berlin-Brandenburg, Germany (bbox 11.26-14.77E, 51.36-53.56N)
- Env vars: None
- Self-hostable: Partially — hafas-rest-api is self-hostable, but depends on upstream HAFAS backends

## weather-bright-sky

### Bright Sky Current Weather — `https://api.brightsky.dev/current_weather`
- Data sent: Coordinates (latitude, longitude)
- Data received: Current conditions: timestamp, temperature (C), cloud cover, icon, precipitation, pressure, humidity, wind speed/direction/gusts
- Purpose: Get current weather conditions (Germany only, from DWD data)
- License: MIT (API software); CC BY 4.0 (DWD data)
- URL: https://brightsky.dev/
- Commercial use: Yes, free for all purposes
- Usage limits: None; no API key required; handles 2M+ req/day aggregate
- Attribution: Not required by Bright Sky; DWD attribution required per GeoNutzV — "Quelle: Deutscher Wetterdienst"
- Privacy: -
- Country: Germany (Jakob de Maeyer, individual, Münster; funded by Prototype Fund / BMBF)
- Privacy other: No formal privacy policy published; open-source personal project
- End-user data exposure: Server-only
- DPA: Not available (individual project)
- Coverage: Germany only (DWD data)
- Env vars: None
- Self-hostable: Yes — Docker Compose setup (<https://github.com/jdemaeyer/brightsky>)

### Bright Sky Weather — `https://api.brightsky.dev/weather`
- Data sent: Coordinates (latitude, longitude), date range
- Data received: Hourly entries: timestamp, temperature, cloud cover, icon, precipitation + probability, pressure, humidity, wind speed/direction. Aggregated to daily client-side.
- Purpose: Get hourly/daily weather forecast (Germany only, from DWD data)
- License: MIT (API software); CC BY 4.0 (DWD data)
- URL: https://brightsky.dev/
- Commercial use: Yes, free for all purposes
- Usage limits: None; no API key required
- Attribution: DWD attribution required — "Quelle: Deutscher Wetterdienst"
- Privacy: -
- Country: Germany (Jakob de Maeyer)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Germany only
- Env vars: None
- Self-hostable: Yes

## weather-met-norway

### MET Norway Location Forecast — `https://api.met.no/weatherapi/locationforecast/2.0/compact`
- Data sent: Coordinates (latitude, longitude)
- Data received: Timeseries with instant details (temperature C, pressure, cloud fraction, humidity, wind speed m/s + gusts + direction) and next_1h/next_6h summaries (symbol code, precipitation amount/probability, min/max temperature)
- Purpose: Get current, hourly, and daily weather forecast. Global coverage. Single endpoint serves all three.
- License: CC BY 4.0 / NLOD 2.0 (dual-licensed)
- URL: https://api.met.no/doc/TermsOfService
- Commercial use: Yes, no fee or special approval needed
- Usage limits: Max 20 req/sec per application; mobile apps max 1 poll/10 min; must respect Expires headers; coordinate precision max 4 decimals
- Attribution: Yes — standard CC BY 4.0 requirements; must not use "Yr" branding or appear to be created by Yr/NRK
- Other: HTTPS only; identifying User-Agent mandatory (app name + contact info)
- Privacy: https://www.met.no/en/About-us/privacy
- Country: Norway (Norwegian Meteorological Institute, government agency)
- Privacy other: Logs IP addresses and geocoordinates from API requests; logs stored in own data center in Oslo, retained up to 90 days; recommends developers use a proxy to protect end-user IPs
- End-user data exposure: Server-only
- DPA: Not available (Norwegian government agency)
- Coverage: Global (despite the name)
- Env vars: None
- Self-hostable: No (use Open-Meteo as self-hosted alternative which ingests MET Norway data)

## weather-open-meteo

### Open-Meteo Forecast API — `https://api.open-meteo.com/v1/forecast`
- Data sent: Coordinates (latitude, longitude), requested weather variables, unit preferences
- Data received: Current: temperature, humidity, apparent temp, weather code (WMO), cloud cover, pressure, wind. Hourly: same per hour. Daily: min/max temp, precipitation sum, max wind, sunrise/sunset.
- Purpose: Get current, hourly (up to 7 days), and daily (up to 16 days) weather forecast. Global coverage.
- License: CC BY 4.0 (free tier: non-commercial only)
- URL: https://open-meteo.com/en/terms
- Commercial use: No on free tier; requires paid subscription (Standard/Professional/Enterprise)
- Usage limits: Free: 600 calls/min, 5,000/hr, 10,000/day, 300,000/month. Paid: up to 50M+/month.
- Attribution: Yes — `<a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a>` next to displayed data
- Privacy: https://open-meteo.com/en/terms
- Country: Switzerland (OpenMeteo GmbH, Bürglen UR)
- Privacy other: Very privacy-friendly — no cookies, no tracking, no third-party analytics on website; free API logs IPs for technical purposes, deleted after 90 days
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: None
- Self-hostable: Yes — AGPLv3, Docker image available (<https://github.com/open-meteo/open-meteo>); requires significant storage for weather model data

## weather-open-meteo-air-quality

### Open-Meteo Air Quality API — `https://air-quality-api.open-meteo.com/v1/air-quality`
- Data sent: Coordinates (latitude, longitude)
- Data received: Current AQI values (European and US scales) and individual pollutant concentrations. Cached 15 min.
- Purpose: Get current air quality index and pollutant levels for a location
- License: CC BY 4.0 (free tier: non-commercial only)
- URL: https://open-meteo.com/en/terms
- Commercial use: No on free tier; requires paid subscription
- Usage limits: Same as Open-Meteo Forecast above
- Attribution: Yes — `<a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a>`
- Privacy: https://open-meteo.com/en/terms
- Country: Switzerland (OpenMeteo GmbH)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: None
- Self-hostable: Yes — same Open-Meteo instance

## weather-openweathermap

### OpenWeatherMap Current Weather — `https://api.openweathermap.org/data/2.5/weather`
- Data sent: Coordinates (latitude, longitude), unit preference, language
- Data received: Temperature, feels-like, humidity, pressure, wind (speed/direction/gusts), cloud cover, weather condition, rain/snow 1h, sunrise/sunset
- Purpose: Get current weather conditions
- License: ODbL
- URL: https://openweathermap.org/full-price
- Commercial use: Yes, on all plans including free
- Usage limits: Free: 60 calls/min, 1,000/day
- Attribution: Yes — "Weather data © OpenWeather" visible where data appears
- Privacy: https://openweather.co.uk/privacy-policy
- Country: UK (OpenWeather Ltd, London)
- Privacy other: Does NOT store API request parameters or retain IP addresses from API requests
- End-user data exposure: Server-only
- DPA: Not available (may be negotiable for enterprise)
- Coverage: Global
- Env vars: `OWM_API_KEY` — required; silently disabled if unset
- Self-hostable: No (use Open-Meteo as self-hosted alternative)

### OpenWeatherMap Forecast — `https://api.openweathermap.org/data/2.5/forecast`
- Data sent: Coordinates (latitude, longitude), unit preference, number of forecast intervals
- Data received: 3-hourly entries: temperature, humidity, pressure, wind, clouds, weather condition, precipitation probability, rain/snow 3h. Daily aggregated client-side (min/max temp, total precip, dominant weather).
- Purpose: Get 3-hourly forecast (up to 5 days); daily summaries derived from 3-hour data
- License: ODbL
- URL: https://openweathermap.org/full-price
- Commercial use: Yes, on all plans including free
- Usage limits: Free: 60 calls/min, 1,000/day
- Attribution: Yes — "Weather data © OpenWeather" visible where data appears
- Privacy: https://openweather.co.uk/privacy-policy
- Country: UK (OpenWeather Ltd)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: `OWM_API_KEY` — required
- Self-hostable: No

# Other services

## better-auth

### OpenStreetMap OAuth Discovery — `https://www.openstreetmap.org/.well-known/openid-configuration`
- Data sent: No user data (static OIDC discovery)
- Data received: OIDC metadata: authorization endpoint, token endpoint, etc.
- Purpose: Discover OSM OAuth2 endpoints for user login/signup
- License: ODbL 1.0 (OSM)
- URL: https://www.openstreetmap.org/copyright
- Commercial use: Yes
- Attribution: Yes — "© OpenStreetMap contributors"
- Privacy: https://osmfoundation.org/wiki/Privacy_Policy
- Country: UK (OpenStreetMap Foundation)
- End-user data exposure: Server-only (better-auth handles OIDC discovery on the server)
- DPA: Not available (OSMF acts as independent controller)
- Coverage: Global
- Env vars: `OSM_CLIENT_ID`, `OSM_CLIENT_SECRET` — optional; OSM login non-functional without
- Self-hostable: No (OSM is the authoritative identity provider)

### OpenStreetMap User Details — `https://api.openstreetmap.org/api/0.6/user/details.json`
- Data sent: OAuth access token
- Data received: User id, display_name, profile image URL (img.href)
- Purpose: Populate user profile (name, avatar) during sign-up and refresh avatar on sign-in
- License: ODbL 1.0 (OSM)
- URL: https://www.openstreetmap.org/copyright
- Commercial use: Yes
- Attribution: Yes — "© OpenStreetMap contributors"
- Privacy: https://osmfoundation.org/wiki/Privacy_Policy
- Country: UK (OpenStreetMap Foundation)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: Same as above
- Self-hostable: No

### Mapillary OAuth Connect — `https://www.mapillary.com/connect`
- Data sent: OAuth authorization request (client ID, scopes, redirect URI)
- Data received: Authorization code (via redirect back)
- Purpose: Redirect user to Mapillary to authorize OAuth login
- License: Proprietary (API service terms)
- URL: https://www.mapillary.com/terms
- Commercial use: Yes, restricted (no reselling, no real-time nav)
- Attribution: Mapillary logo + link
- Privacy: https://www.mapillary.com/privacy
- Country: Ireland / US (Meta Platforms)
- End-user data exposure: Direct (browser redirect) — user intentionally navigates to Mapillary for authentication; end-user IP exposed to Meta
- DPA: Not available (Meta acts as controller)
- Coverage: Global
- Env vars: `MAPILLARY_CLIENT_ID`, `MAPILLARY_CLIENT_SECRET` — optional; Mapillary login non-functional without
- Self-hostable: No

### Mapillary Token Exchange — `https://graph.mapillary.com/token`
- Data sent: OAuth authorization code
- Data received: Access token, expires_in, token_type
- Purpose: Exchange authorization code for Mapillary access token
- License: Proprietary (API service terms)
- URL: https://www.mapillary.com/terms
- Privacy: https://www.mapillary.com/privacy
- Country: Ireland / US (Meta Platforms)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: Same as above
- Self-hostable: No

### Mapillary User Info — `https://graph.mapillary.com/me?fields=id,username`
- Data sent: OAuth access token
- Data received: User id and username. Email synthesized as {id}@mapillary.invalid.
- Purpose: Get user identity after OAuth login to create/link account
- License: Proprietary (API service terms)
- URL: https://www.mapillary.com/terms
- Privacy: https://www.mapillary.com/privacy
- Country: Ireland / US (Meta Platforms)
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: Same as above
- Self-hostable: No

## CyclOSM

### Cycling Tiles — `https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png`
- License: ODbL (OSM data); BSD-3-Clause (style); OSMF tile usage policy
- Data sent: Tile coordinates (z/x/y)
- Data received: PNG cycling map raster tile (256x256)
- Purpose: Provide cycling base layer tiles; used as fallback when Thunderforest is not configured
- URL: https://operations.osmfoundation.org/policies/tiles/
- Commercial use: Technically yes (ODbL), but strongly discouraged on OSMF servers; commercial users risk access withdrawal
- Usage limits: No published numeric limits; no bulk downloading, no prefetching beyond active viewport; HTTPS required; custom User-Agent mandatory; local tile caching mandatory (min 7 days)
- Attribution: Yes — "© OpenStreetMap contributors" with link; must not be hidden
- Privacy: https://osmfoundation.org/wiki/Privacy_Policy
- Country: UK (OpenStreetMap Foundation)
- End-user data exposure: Proxied via BFF — tiles served through /api/tiles/cyclosm/; only our server IP is exposed
- DPA: Not available
- Coverage: Global
- Env vars: `CYCLOSM_TILE_URL` — optional (override tile URL)
- Self-hostable: Yes — Docker tile server (<https://github.com/mhajder/openstreetmap-tile-server-cyclosm>)

## EmailLabs

### Email Sending API — `https://api.emaillabs.net.pl/api/new_sendmail`
- Data sent: Recipient email address, sender address, subject, message body (HTML and plain text)
- Data received: HTTP success/failure status
- Purpose: Send transactional emails (verification, password reset, 2FA). First priority if EmailLabs env vars are set.
- License: Proprietary
- URL: https://emaillabs.io/en/terms-conditions/
- Commercial use: Yes — designed for business use
- Usage limits: Free: 100 emails/day or 24,000/month (800/day)
- Attribution: Not required
- Privacy: https://emaillabs.io/en/privacy-policy/
- Country: Poland (Vercom S.A., Poznań)
- Privacy other: DPO: iod@vercom.pl; ISO 27001 and 27018 certified; DPA available; data within EEA; EU-US Data Privacy Framework certified
- End-user data exposure: Server-only
- DPA: Available — via EmailLabs Panel GDPR section (<https://docs.emaillabs.io/en/first-steps/gdpr-agreement>)
- Coverage: Global (email delivery)
- Env vars: `EMAILLABS_APP_KEY`, `EMAILLABS_SECRET_KEY`, `EMAILLABS_SMTP_ACCOUNT` — optional set; first-priority email provider if all three are set
- Self-hostable: No

## GitHub API

### Zen (status check) — `https://api.github.com/zen`
- Data sent: No user data (health check)
- Data received: Random GitHub zen phrase (plain text); only HTTP status code matters
- Purpose: Check if GitHub API is reachable for the status dashboard
- License: Proprietary (GitHub ToS)
- URL: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
- Commercial use: Per repo license
- Usage limits: 5,000 req/hr authenticated
- Attribution: Per repo license
- Privacy: https://docs.github.com/site-policy/privacy-policies/github-privacy-statement
- Country: US (GitHub, Inc. / Microsoft; EU: GitHub B.V., Amsterdam)
- End-user data exposure: Server-only
- DPA: Available — <https://github.com/customer-terms/github-data-protection-agreement>
- Coverage: N/A (health check)
- Env vars: `GITHUB_TOKEN` — optional
- Self-hostable: No

## Google Fonts

### Material Icons — `https://fonts.googleapis.com/icon?family=Material+Icons`
- Data sent: No user data (static resource)
- Data received: CSS stylesheet with @font-face rules pointing to WOFF2 font files on fonts.gstatic.com
- Purpose: Load Material Icons icon font for UI icons. Note: Plus Jakarta Sans is downloaded at build time via next/font (not runtime).
- License: SIL Open Font License 1.1 (fonts); Google APIs ToS (service)
- URL: https://developers.google.com/fonts/terms
- Commercial use: Yes, unrestricted (including sold products)
- Usage limits: No practical limits for CSS font-serving endpoint
- Attribution: Not required for usage; include OFL license file if redistributing font files
- Privacy: https://developers.google.com/fonts/faq/privacy
- Country: US (Google LLC / Alphabet Inc., Mountain View, CA)
- Privacy other: Collects end-user IP addresses; Google states no profiling or ad targeting from Fonts data; 2022 German court ruled Google Fonts not GDPR-compliant by default due to IP transfer to US; self-hosting avoids this
- End-user data exposure: Self-hosted — Material Icons font file served from our own domain; no runtime contact with Google. Plus Jakarta Sans also self-hosted via next/font.
- DPA: Not available (Google acts as independent controller for Fonts, not processor; German court LG Munich 2022 ruled CDN-loaded Google Fonts violates GDPR; self-hosting recommended)
- Coverage: Global
- Env vars: None
- Self-hostable: Yes — self-host font files; Plus Jakarta Sans already self-hosted via next/font at build time. Material Icons can be self-hosted similarly.

## Lettermint

### SDK-based — via `lettermint` npm package (no direct HTTP endpoint)
- Data sent: Sender address, recipient email address, subject, message body (HTML and plain text)
- Data received: Promise resolves on success
- Purpose: Send transactional emails. Second priority when EmailLabs is not configured but LETTERMINT_API_TOKEN is set.
- License: MIT
- URL: https://libraries.io/npm/lettermint
- Commercial use: Yes, unrestricted
- Attribution: MIT license text when redistributing package
- Privacy: https://lettermint.co/privacy-policy
- Country: Netherlands (Lettermint B.V., Zwolle)
- Privacy other: GDPR-compliant; data within EEA; DPA at https://lettermint.co/dpa; AI features may use Mistral AI as sub-processor
- End-user data exposure: Server-only
- DPA: Available — <https://lettermint.co/dpa>
- Coverage: Global (email delivery)
- Env vars: `LETTERMINT_API_TOKEN` — optional; second-priority email provider
- Self-hostable: No

## MapTiler

### Map Styles — `https://api.maptiler.com/maps/{style}/style.json?key={key}`
- Data sent: Map style name
- Data received: MapLibre GL style JSON specification (sources, layers, sprite/glyph URLs)
- Purpose: Load the base map style definition. Only used when styleProvider is 'maptiler' (default).
- License: Proprietary
- URL: https://www.maptiler.com/terms/cloud/
- Commercial use: Free plan: non-commercial/R&D only. Paid plans: yes.
- Usage limits: Per plan caps; bulk downloading and server-side caching prohibited without written agreement
- Attribution: Yes — "© MapTiler © OpenStreetMap contributors" (bottom-right); free plan requires MapTiler logo (bottom-left)
- Privacy: https://www.maptiler.com/privacy-policy/
- Country: Switzerland (MapTiler AG, Unterägeri)
- Privacy other: No end-user tracking; Cloudflare stores IPs max 20 min; DPAs for enterprise; data centers in EU
- End-user data exposure: Direct — browser/MapLibre loads style JSON directly from api.maptiler.com; end-user IP and viewport are exposed to MapTiler
- DPA: Available on request — <https://explore.openli.com/privacy/maptiler-cloud/data-processing-agreements>
- Coverage: Global
- Env vars: `NEXT_PUBLIC_MAPTILER_KEY` — required; `NEXT_PUBLIC_MAP_STYLE_URL` — optional (override for self-hosted style)
- Self-hostable: Yes — OpenMapTiles + TileServer GL or Martin (<https://openmaptiles.org/>); already in project Docker Compose via Martin

### Vector Tiles — `https://api.maptiler.com/tiles/v3-openmaptiles/tiles.json?key={key}`
- Data sent: No user data (static metadata)
- Data received: TileJSON metadata (tile URLs, bounds, zoom range, attribution)
- Purpose: Vector tile source metadata for the custom OpenMapX map style
- License: Proprietary
- URL: https://www.maptiler.com/terms/cloud/
- Commercial use: Free plan: non-commercial only. Paid plans: yes.
- Attribution: Yes — "© MapTiler © OpenStreetMap contributors"
- Privacy: https://www.maptiler.com/privacy-policy/
- Country: Switzerland (MapTiler AG)
- End-user data exposure: Direct — MapLibre loads vector tiles directly from api.maptiler.com
- DPA: Available on request (see Map Styles above)
- Coverage: Global
- Env vars: `NEXT_PUBLIC_MAPTILER_KEY` — required; `NEXT_PUBLIC_TILES_URL` — optional (self-hosted tiles)
- Self-hostable: Yes — OpenMapTiles + Martin

### Satellite Tiles — `https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key={key}`
- Data sent: Tile coordinates (z/x/y)
- Data received: JPEG satellite imagery raster tiles
- Purpose: Satellite base layer (activated via LayerSelector)
- License: Proprietary
- URL: https://www.maptiler.com/terms/cloud/
- Commercial use: Free plan: non-commercial only. Paid plans: yes.
- Attribution: Yes — "© MapTiler © OpenStreetMap contributors"
- Privacy: https://www.maptiler.com/privacy-policy/
- Country: Switzerland (MapTiler AG)
- End-user data exposure: Direct — MapLibre loads satellite imagery directly from api.maptiler.com
- DPA: Available on request (see Map Styles above)
- Coverage: Global
- Env vars: `NEXT_PUBLIC_MAPTILER_KEY` — required
- Self-hostable: No (satellite imagery requires commercial data sources)

### Font Glyphs — `https://api.maptiler.com/fonts`
- Data sent: Font name, Unicode range
- Data received: Protocol buffer (PBF) file with signed distance field glyphs
- Purpose: Render text labels on the map when no self-hosted style URL is configured
- License: Proprietary
- URL: https://www.maptiler.com/terms/cloud/
- Commercial use: Free plan: non-commercial only. Paid plans: yes.
- Attribution: Yes — "© MapTiler © OpenStreetMap contributors"
- Privacy: https://www.maptiler.com/privacy-policy/
- Country: Switzerland (MapTiler AG)
- End-user data exposure: Direct — MapLibre loads font PBF files directly from api.maptiler.com
- DPA: Available on request (see Map Styles above)
- Coverage: Global
- Env vars: `NEXT_PUBLIC_MAPTILER_KEY` — required
- Self-hostable: Yes — self-host font PBF files alongside tiles

## Mapillary (OAuth)

### Connect URL — `https://www.mapillary.com/connect`
- License: Proprietary (API service terms)
- URL: https://www.mapillary.com/terms
- Commercial use: Yes, restricted (no reselling, no real-time nav)
- Attribution: Mapillary logo + link
- Privacy: https://www.mapillary.com/privacy
- Country: Ireland / US (Meta Platforms)
- Data sent: OAuth authorization request (client ID, scopes, redirect URI)
- Data received: Authorization code via redirect back to our server
- Purpose: Redirect user to Mapillary to authorize OAuth login
- End-user data exposure: Direct (browser redirect) — user navigates to Mapillary for OAuth authorization
- DPA: Not available (Meta acts as controller)
- Coverage: Global
- Env vars: `MAPILLARY_CLIENT_ID` — optional
- Self-hostable: No

### Token URL — `https://graph.mapillary.com/token`
- License: Proprietary (API service terms)
- URL: https://www.mapillary.com/terms
- Privacy: https://www.mapillary.com/privacy
- Country: Ireland / US (Meta Platforms)
- Data sent: OAuth authorization code
- Data received: Access token, expires_in, token_type
- Purpose: Exchange authorization code for Mapillary access token
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: `MAPILLARY_CLIENT_SECRET` — optional
- Self-hostable: No

### User Info — `https://graph.mapillary.com/me?fields=id,username`
- License: Proprietary (API service terms)
- URL: https://www.mapillary.com/terms
- Privacy: https://www.mapillary.com/privacy
- Country: Ireland / US (Meta Platforms)
- Data sent: OAuth access token
- Data received: User id and username. Email synthesized as {id}@mapillary.invalid.
- Purpose: Get Mapillary user identity after OAuth login to create/link account
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: None (uses access token from OAuth flow)
- Self-hostable: No

## Nodemailer (SMTP)

### Generic SMTP — configured via `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`

Not applicable (generic protocol, no third-party service terms).

## OpenMapX Community Integrations Catalog

### Catalog JSON — `https://raw.githubusercontent.com/openmapx/community-integrations/main/catalog.json`
- Data sent: No user data (static resource)
- Data received: JSON array of integration entries: id, name, description, author, repository, version, minPlatform, domains, quality, tags
- Purpose: Provide catalog of community integrations available for installation. Cached 24h in Redis.
- License: Proprietary (GitHub ToS for hosting)
- URL: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
- Commercial use: Per repo license
- Usage limits: GitHub API rate limits apply
- Privacy: https://docs.github.com/site-policy/privacy-policies/github-privacy-statement
- Country: US (GitHub / Microsoft)
- End-user data exposure: Server-only
- DPA: Available — <https://github.com/customer-terms/github-data-protection-agreement> (GitHub hosting)
- Coverage: N/A (integration store)
- Env vars: `STORE_CATALOG_URL` — optional (override catalog URL)
- Self-hostable: No

## OpenStreetMap (OAuth)

### OAuth Discovery — `https://www.openstreetmap.org/.well-known/openid-configuration`
- License: ODbL 1.0
- URL: https://www.openstreetmap.org/copyright
- Commercial use: Yes
- Attribution: Yes — "© OpenStreetMap contributors" with link to openstreetmap.org/copyright
- Privacy: https://osmfoundation.org/wiki/Privacy_Policy
- Country: UK (OpenStreetMap Foundation, Cambridge)
- Data sent: No user data (static OIDC discovery)
- Data received: OIDC metadata: authorization endpoint, token endpoint, etc.
- Purpose: Discover OSM OAuth2 endpoints for user login/signup
- End-user data exposure: Server-only
- DPA: Not available (OSMF acts as independent controller)
- Coverage: Global
- Env vars: `OSM_CLIENT_ID`, `OSM_CLIENT_SECRET` — optional
- Self-hostable: No

### User Details — `https://api.openstreetmap.org/api/0.6/user/details.json`
- License: ODbL 1.0
- URL: https://www.openstreetmap.org/copyright
- Commercial use: Yes
- Attribution: Yes — "© OpenStreetMap contributors"
- Privacy: https://osmfoundation.org/wiki/Privacy_Policy
- Country: UK (OpenStreetMap Foundation)
- Data sent: OAuth access token
- Data received: User id, display_name, profile image URL (img.href)
- Purpose: Populate user profile (name, avatar) during sign-up and refresh avatar on each sign-in
- End-user data exposure: Server-only
- DPA: Not available
- Coverage: Global
- Env vars: Same as above
- Self-hostable: No

## OpenTopoMap

### Terrain Tiles — `https://tile.opentopomap.org/{z}/{x}/{y}.png`
- Data sent: Tile coordinates (z/x/y)
- Data received: PNG topographic raster tiles
- Purpose: Terrain base layer (activated via LayerSelector)
- License: CC BY-SA (tiles); ODbL (OSM data)
- URL: https://opentopomap.org/about
- Commercial use: Yes
- Usage limits: None explicit; mass downloads discouraged; hobby project with no availability guarantee
- Attribution: Yes — "Map data: © OpenStreetMap contributors, SRTM | Map rendering: © OpenTopoMap (CC-BY-SA)"
- Other: Share-alike — derivative maps must also be CC-BY-SA
- Privacy: -
- Country: Germany (Stefan Erhardt and Philipp Hochreuther, individuals; supported by FAU Erlangen-Nürnberg)
- Privacy other: Volunteer/hobby project; no formal legal entity or privacy policy
- End-user data exposure: Proxied via BFF — tiles served through /api/tiles/terrain/; only our server IP is exposed to OpenTopoMap
- DPA: Not available (volunteer project, no legal entity)
- Coverage: Global
- Env vars: None
- Self-hostable: Yes — Docker image available (<https://github.com/lukey78/otm-docker>); resource-intensive (~3 TB for worldwide tiles)

## Thunderforest

### Cycling Tiles — `https://{s}.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey={key}`
- License: Proprietary
- URL: https://www.thunderforest.com/terms/
- Data sent: Tile coordinates (z/x/y)
- Data received: PNG cycling map raster tile
- Purpose: Primary cycling base layer tiles; falls back to CyclOSM if API key not configured or request fails
- Commercial use: Yes, permitted and encouraged
- Usage limits: No specific published limits; high-traffic sites will be contacted; bulk downloading/scraping/pre-caching prohibited without Small Business plan+; API key required
- Attribution: Yes — web: "Maps © Thunderforest, Data © OpenStreetMap contributors" with hyperlinks; print: "Maps © www.thunderforest.com, Data © www.osm.org/copyright"
- Privacy: https://www.thunderforest.com/privacy/
- Country: UK (Gravitystorm Limited, New Malden, England)
- Privacy other: Uses Fathom Analytics (privacy-focused); servers at Hetzner in EU; UK GDPR and EU GDPR compliant
- End-user data exposure: Proxied via BFF — tiles served through /api/tiles/cyclosm/ (Thunderforest primary, CyclOSM fallback); only our server IP is exposed
- DPA: Not available (may be on request for commercial customers; contact Gravitystorm)
- Coverage: Global
- Env vars: `THUNDERFOREST_API_KEY` — optional; falls back to CyclOSM if unset
- Self-hostable: No (proprietary style; use CyclOSM as open alternative)

## Transitous

### GitHub Tree API — `https://api.github.com/repos/public-transport/transitous/git/trees/main?recursive=1`
- License: Proprietary (GitHub ToS)
- Data sent: No user data (static resource)
- Data received: Full recursive file tree of the Transitous repo; paths matching feeds/*.json extracted as feed definition files
- Purpose: Enumerate available GTFS feed definition files from the Transitous catalog
- URL: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
- Usage limits: 5,000 req/hr authenticated
- Privacy: https://docs.github.com/site-policy/privacy-policies/github-privacy-statement
- Country: US (GitHub / Microsoft)
- End-user data exposure: Server-only
- DPA: Available — <https://github.com/customer-terms/github-data-protection-agreement> (GitHub hosting)
- Coverage: N/A (GTFS catalog metadata)
- Env vars: `GITHUB_TOKEN` — optional
- Self-hostable: No

### Raw Feed Files — `https://raw.githubusercontent.com/public-transport/transitous/main/feeds/{country}.json`
- Data sent: Country identifier (file path)
- Data received: Feed definitions: name, type, download URL, license (SPDX), skip flag. Only type=http + spec=gtfs entries included.
- Purpose: Build the GTFS feed catalog from Transitous feed definitions. Cached 24h in memory.
- License: AGPL-3.0-or-later (Transitous project); feed data is CC0-1.0
- URL: https://github.com/public-transport/transitous
- Commercial use: AGPL-3.0 for project code; CC0 for feed data (unrestricted)
- Privacy: https://transitous.org/privacy/
- Country: Germany (community project)
- End-user data exposure: Server-only
- DPA: Available — <https://github.com/customer-terms/github-data-protection-agreement> (GitHub hosting)
- Coverage: N/A (GTFS feed definitions)
- Env vars: `GITHUB_TOKEN` — optional
- Self-hostable: No

## Waymarked Trails

### Cycling Routes Tiles — `https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png`
- Data sent: Tile coordinates (z/x/y)
- Data received: PNG raster tile showing cycling route overlay (semi-transparent)
- Purpose: Cycling route overlay layer, displayed on top of the cycling base layer
- License: CC BY-SA 3.0 DE (tiles/overlay); ODbL (OSM data)
- URL: https://hiking.waymarkedtrails.org/#help-legal
- Commercial use: Yes
- Usage limits: Reasonable access rates; caching encouraged; bulk GPX downloads not permitted
- Attribution: Yes — "© waymarkedtrails.org, OpenStreetMap contributors, CC by-SA 3.0"
- Privacy: -
- Country: Germany (Sarah Hoffmann, individual, Dresden)
- End-user data exposure: Proxied via BFF — tiles served through /api/tiles/cycling-routes/; only our server IP is exposed
- DPA: Not available (individual project, no legal entity)
- Coverage: Global
- Env vars: `WAYMARKED_CYCLING_TILE_URL` — optional
- Self-hostable: No
