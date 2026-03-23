import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { legalConfig } from "@/lib/legalConfig";
import { sectionSlug } from "@/lib/sectionSlug";

export default function PrivacyContent() {
  const { name, street, postalCode, city, country, email } = legalConfig;

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 1 }}>
        Privacy Policy
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
        Last updated: March 2026
      </Typography>

      <Section title="1. Controller and Contact">
        <Typography>
          The controller responsible for data processing on this website within the meaning of the
          General Data Protection Regulation (GDPR) is:
        </Typography>
        <Typography sx={{ mt: 1 }}>
          {name}
          <br />
          {street}
          <br />
          {postalCode} {city}, {country}
          <br />
          Email: <Link href={`mailto:${email}`}>{email}</Link>
        </Typography>
      </Section>

      <Section title="2. Overview of Data Processing">
        <Typography>
          OpenMapX is an open-data mapping platform. We are committed to minimizing the personal
          data we process. We do <strong>not</strong> use any analytics, tracking, or advertising
          services. We do not sell or share your personal data with third parties for marketing
          purposes.
        </Typography>
        <Typography sx={{ mt: 1 }}>Data processing occurs in the following contexts:</Typography>
        <ul>
          <li>
            <Typography>
              Providing the mapping service (map tiles, search, routing, isochrones, elevation
              profiles)
            </Typography>
          </li>
          <li>
            <Typography>
              Displaying third-party data layers (traffic, transit, air quality, natural disasters,
              hiking trails, street-level imagery, place photos, parking, fuel prices, EV charging,
              shared mobility)
            </Typography>
          </li>
          <li>
            <Typography>User account management (if you create an account)</Typography>
          </li>
          <li>
            <Typography>
              Client-side storage of preferences and saved places on your device
            </Typography>
          </li>
          <li>
            <Typography>Server-side caching for performance optimization</Typography>
          </li>
        </ul>
      </Section>

      <Section title="3. Hosting and Server Logs">
        <Typography>
          When you visit OpenMapX, your browser automatically transmits certain technical data to
          our server. This may include:
        </Typography>
        <ul>
          <li>
            <Typography>IP address</Typography>
          </li>
          <li>
            <Typography>Date and time of the request</Typography>
          </li>
          <li>
            <Typography>Browser type and version</Typography>
          </li>
          <li>
            <Typography>Operating system</Typography>
          </li>
          <li>
            <Typography>Referrer URL</Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          This data is processed to ensure the technical operation and security of the service. The
          legal basis is Art. 6(1)(f) GDPR (legitimate interest in providing a secure and functional
          service). Server logs are automatically deleted after 30 days.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Our servers are hosted by Hetzner Online GmbH, Industriestr.&nbsp;25, 91710 Gunzenhausen,
          Germany. Hetzner processes data on our behalf and exclusively according to our
          instructions (data processor pursuant to Art.&nbsp;28 GDPR). A data processing agreement
          is in place. Hetzner&apos;s data centers are located in Germany and Finland (EU).
        </Typography>
      </Section>

      <Section title="4. Geolocation Data">
        <Typography>
          OpenMapX may request your device&apos;s location only when you explicitly click the
          &quot;My Location&quot; button. Your browser will ask for permission before sharing this
          data. Location data is:
        </Typography>
        <ul>
          <li>
            <Typography>Used exclusively to center the map on your position</Typography>
          </li>
          <li>
            <Typography>Processed only in your browser (client-side)</Typography>
          </li>
          <li>
            <Typography>
              Not stored on our servers and not transmitted unless you actively use features that
              require coordinates (e.g., routing, nearby search, transit departures)
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          The legal basis is Art. 6(1)(a) GDPR (your explicit consent via the browser permission
          prompt).
        </Typography>
      </Section>

      <Section title="5. User Accounts">
        <Typography>
          You can use OpenMapX without creating an account. If you choose to register, we process:
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Name and email address</strong> — for account identification and communication
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Password</strong> — stored only as a cryptographic hash (never in plain text)
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Passkeys (WebAuthn)</strong> — if you register a passkey, a public-key
              credential is stored on our server; the private key never leaves your device
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Session data</strong> — authentication cookies to keep you signed in
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Saved places</strong> — if you save places while signed in, the place name,
              coordinates, and associated metadata are stored in our database so they can be
              synchronized across devices
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          You may also sign in via third-party OAuth providers (OpenStreetMap, Mapillary). In that
          case, we receive your public profile information (name, profile picture URL) from the
          respective provider. We do not receive or store your password for these providers.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          The legal basis is Art. 6(1)(b) GDPR (performance of a contract / provision of the service
          you requested). You can delete your account at any time via the account settings.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          The provision of personal data is neither a statutory nor a contractual requirement. You
          can use OpenMapX without providing any personal data. Creating an account requires an
          email address; without it, account-dependent features (such as saved places
          synchronization) cannot be provided.
        </Typography>
      </Section>

      <Section title="6. Third-Party Services and Data Transfers">
        <Typography>
          To provide its mapping features, OpenMapX sends requests to various third-party APIs. When
          you use a feature, certain data (typically map viewport coordinates, search queries, or
          route waypoints) is transmitted to the respective provider. Our backend server acts as a
          proxy for most of these requests, meaning third-party providers generally see our
          server&apos;s IP address rather than yours. Below is a comprehensive list of all external
          services:
        </Typography>

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 2, mb: 1 }}>
          6.1 Map Tiles and Display
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "MapTiler",
              purpose: "Base map tiles (streets, satellite, terrain), map styles",
              dataSent: "Map viewport coordinates, zoom level, API key",
              country: "Switzerland",
              privacy: "https://www.maptiler.com/privacy-policy/",
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
              service: "Waymarked Trails (tile overlay)",
              purpose: "Cycling route overlay tiles",
              dataSent: "Tile coordinates (z/x/y)",
              country: "Germany",
              privacy: "https://cycling.waymarkedtrails.org/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.2 Geocoding and Search
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "MapTiler Geocoding",
              purpose: "Address and place search",
              dataSent: "Search queries, bounding box, language",
              country: "Switzerland",
              privacy: "https://www.maptiler.com/privacy-policy/",
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
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.3 Routing, Isochrones, and Elevation
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OSRM (public demo server)",
              purpose: "Car route calculation, route optimization",
              dataSent: "Waypoint coordinates, route options (avoid highways/tolls/ferries)",
              country: "Germany",
              privacy: "https://project-osrm.org/",
            },
            {
              service: "Valhalla (FOSSGIS e.V.)",
              purpose:
                "Walking, cycling, and driving routes; isochrone calculation; elevation profiles",
              dataSent:
                "Waypoint coordinates, routing mode, avoid options, isochrone parameters, elevation sample points",
              country: "Germany",
              privacy: "https://fossgis.de/datenschutzerkl%C3%A4rung/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.4 Traffic Data
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "TomTom",
              purpose: "Live traffic flow overlay",
              dataSent: "Map tile coordinates, API key",
              country: "Netherlands",
              privacy: "https://www.tomtom.com/privacy/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.5 Street-Level Imagery
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Mapillary (Meta Platforms)",
              purpose: "Street-level photos, panoramas, and coverage layer",
              dataSent: "Coordinates, bounding box, image IDs, access token",
              country: "USA",
              privacy: "https://www.mapillary.com/privacy",
            },
            {
              service: "Panoramax (IGN France)",
              purpose: "Open street-level panorama imagery",
              dataSent: "Coordinates",
              country: "France",
              privacy: "https://panoramax.fr/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.6 Place Photos
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Flickr (SmugMug)",
              purpose: "CC-licensed place photos for photo galleries",
              dataSent: "Coordinates, search radius, API key",
              country: "USA",
              privacy: "https://www.flickr.com/help/privacy",
            },
            {
              service: "Wikimedia Commons (Wikimedia Foundation)",
              purpose: "Geo-tagged free-licensed photos for photo galleries",
              dataSent: "Coordinates, search radius",
              country: "USA",
              privacy: "https://foundation.wikimedia.org/wiki/Privacy_policy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.7 Public Transit
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Transitous (MOTIS)",
              purpose: "Multimodal transit trip planning (global)",
              dataSent: "Start/end coordinates, date/time, modes",
              country: "Germany",
              privacy: "https://transitous.org/privacy/",
            },
            {
              service: "Deutsche Bahn RIS APIs (Stations, Routing, Maps, Transports)",
              purpose:
                "German rail station data, journey planning, route geometry, live train positions",
              dataSent:
                "Station queries, coordinates, date/time, journey IDs, API credentials (server-side)",
              country: "Germany",
              privacy: "https://www.bahn.de/datenschutz",
            },
            {
              service: "TransitLand (Interline Technologies)",
              purpose: "Transit stops, routes, and departures",
              dataSent: "Bounding box, stop/route queries, API key (server-side)",
              country: "USA",
              privacy: "https://www.transit.land/terms",
            },
            {
              service: "Transport for London (TfL)",
              purpose: "London transit stops, routes, arrivals, and line statuses",
              dataSent: "Stop/line queries, coordinates, API key (server-side)",
              country: "UK",
              privacy: "https://tfl.gov.uk/corporate/privacy-and-cookies/",
            },
            {
              service: "MBTA (Massachusetts Bay Transportation Authority)",
              purpose: "Boston area transit stops, routes, and live departures",
              dataSent: "Stop/prediction queries, coordinates, API key (server-side)",
              country: "USA",
              privacy: "https://www.mbta.com/policies/privacy-policy",
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
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.8 Air Quality
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OpenAQ",
              purpose: "Air quality measurements (PM2.5, AQI)",
              dataSent: "Bounding box coordinates",
              country: "USA",
              privacy: "https://openaq.org/privacy/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.9 Natural Disaster Data
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "NASA FIRMS (Fire Information for Resource Management System)",
              purpose: "Active wildfire/hotspot detections worldwide",
              dataSent: "Data source selection, time range, API key (server-side)",
              country: "USA",
              privacy: "https://www.nasa.gov/privacy/",
            },
            {
              service: "USGS Earthquake Hazards Program",
              purpose: "Earthquake locations, magnitudes, and depths",
              dataSent: "Time range, magnitude threshold (via pre-built URL; no user data sent)",
              country: "USA",
              privacy: "https://www.usgs.gov/privacy-policies",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.10 Hiking and Outdoor
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Waymarked Trails",
              purpose: "Hiking and cycling trail metadata (name, difficulty, length)",
              dataSent: "Search queries, bounding box",
              country: "Germany",
              privacy: "https://hiking.waymarkedtrails.org/",
            },
            {
              service: "Overpass API (OpenStreetMap)",
              purpose:
                "Hiking trails, winter sport areas, and other outdoor features from OpenStreetMap",
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
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.11 EV Charging Stations
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OpenChargeMap",
              purpose: "EV charging station locations, connector types, and availability",
              dataSent: "Bounding box, filter parameters (connector type, usage type), API key",
              country: "UK",
              privacy: "https://community.openchargemap.org/privacy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.12 Fuel Prices
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Tankerkoenig (MTS-K)",
              purpose: "German fuel station prices (E5, E10, Diesel)",
              dataSent: "Coordinates, search radius, API key",
              country: "Germany",
              privacy: "https://creativecommons.tankerkoenig.de/",
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
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.13 Parking
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "DB BahnPark (Deutsche Bahn)",
              purpose: "Parking facilities at German train stations (capacity, occupancy, pricing)",
              dataSent: "API credentials (server-side)",
              country: "Germany",
              privacy: "https://www.bahn.de/datenschutz",
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
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.14 Shared Mobility (Bikes, Scooters, Car-Sharing)
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Deutsche Bahn GBFS (Call-a-Bike / StadtRad)",
              purpose: "DB bike-sharing station data",
              dataSent: "API credentials (server-side)",
              country: "Germany",
              privacy: "https://www.bahn.de/datenschutz",
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
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.15 Place Enrichment
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Wikipedia (Wikimedia Foundation)",
              purpose: "Place descriptions, article summaries, thumbnail images",
              dataSent: "Article titles, language code",
              country: "USA",
              privacy: "https://foundation.wikimedia.org/wiki/Privacy_policy",
            },
            {
              service: "Wikidata (Wikimedia Foundation)",
              purpose: "Structured place facts (population, founding date, architect, etc.)",
              dataSent: "Wikidata entity IDs",
              country: "USA",
              privacy: "https://foundation.wikimedia.org/wiki/Privacy_policy",
            },
            {
              service: "Wikimedia Commons (Wikimedia Foundation)",
              purpose: "Image metadata, attribution, and license information",
              dataSent: "File names",
              country: "USA",
              privacy: "https://foundation.wikimedia.org/wiki/Privacy_policy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.16 Authentication Providers
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OpenStreetMap OAuth 2.0",
              purpose: "User sign-in via OSM account",
              dataSent: "OAuth authorization flow (no password shared with us)",
              country: "UK",
              privacy: "https://osmfoundation.org/wiki/Privacy_Policy",
            },
            {
              service: "Mapillary OAuth (Meta Platforms)",
              purpose: "User sign-in via Mapillary account",
              dataSent: "OAuth authorization flow (no password shared with us)",
              country: "USA",
              privacy: "https://www.mapillary.com/privacy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.17 Software Registries and Catalogs
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "GitHub API (Microsoft)",
              purpose:
                "Fetching transit API registry and GTFS feed catalog from open-source repositories (server-side only)",
              dataSent: "Repository file paths; optionally a GitHub token for rate limits",
              country: "USA",
              privacy:
                "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement",
            },
          ]}
        />

        <Typography sx={{ mt: 2 }}>
          <strong>Note on data flow:</strong> For most of the above services, requests are routed
          through our backend server (API proxy). This means that the third-party provider typically
          receives our server&apos;s IP address, not your browser&apos;s IP address. Exceptions are
          map tiles loaded directly by your browser (MapTiler, OpenTopoMap, CyclOSM, Waymarked
          Trails tile overlays) and the MapillaryJS street-view viewer, where your browser connects
          directly to the provider.
        </Typography>

        <Typography sx={{ mt: 2 }}>
          <strong>International transfers:</strong> Some of the above services are operated by
          entities in the USA or other countries outside the European Economic Area (EEA). A
          transfer of personal data to a third country only occurs where your data (such as your IP
          address or coordinates) actually reaches that provider:
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Direct browser connections to US providers:</strong> The MapillaryJS
              street-view viewer (Meta Platforms, Inc.) connects directly from your browser,
              exposing your IP address and viewed coordinates. Meta is certified under the EU-U.S.
              Data Privacy Framework (DPF).
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Server-proxied requests forwarding coordinates:</strong> For services like
              Flickr, Wikimedia Commons, TransitLand, and Link, our backend may forward map viewport
              coordinates (not your IP address) as part of the query. These coordinates reflect the
              area displayed on the map and are not inherently linked to your identity or physical
              location.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>No personal data transferred:</strong> Several US-based services (NASA FIRMS,
              USGS, GitHub API) receive no user-related data at all. Our server fetches public data
              feeds or repository files without transmitting any coordinates, search queries, or
              user identifiers. No transfer of personal data occurs in these cases.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          The legal basis for all third-party service requests is Art.&nbsp;6(1)(f) GDPR (legitimate
          interest in providing the mapping service you are using).
        </Typography>
      </Section>

      <Section title="7. Cookies and Local Storage">
        <Typography>
          OpenMapX uses only technically necessary storage mechanisms. Each item below is required
          for the service to function as requested by the user:
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Session cookie</strong> — If you sign in, an HTTP-only session cookie is set
              to authenticate your requests. This cookie is essential for the login functionality
              and is deleted when you sign out or when it expires.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Language preference cookie</strong> (<code>NEXT_LOCALE</code>) — If you
              explicitly switch the interface language, your choice (e.g., &quot;en&quot; or
              &quot;de&quot;) is stored in a first-party cookie (max-age: 1 year, SameSite: lax) so
              the interface remembers it across visits. This cookie is only set when you actively
              select a language. If you have not made an explicit choice, your browser&apos;s
              language setting is used automatically without storing a cookie.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>View preferences</strong> — A small number of display settings (e.g., globe
              vs. flat map projection) are saved in localStorage so the interface restores your
              last-used view. No personal data is involved.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Service Worker cache</strong> — A Service Worker caches static assets (HTML,
              CSS, JavaScript), map tiles, and recent API responses (search results, routes) using
              the browser&apos;s Cache Storage API. This enables offline functionality and faster
              loading. Cached entries expire automatically (static assets: 30 days; map tiles:
              3&ndash;7 days; API responses: minutes to 1 day). No personal data is stored.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Browser memory cache</strong> — API responses are additionally cached in
              browser memory (via TanStack Query) during your session for performance. This data is
              discarded when you close the tab.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          We do <strong>not</strong> use any tracking cookies, analytics cookies, or advertising
          cookies. No cookie consent banner is required because all of the above storage mechanisms
          are strictly necessary for providing the service you requested
          (&sect;&nbsp;25(2)&nbsp;TDDDG, implementing Art.&nbsp;5(3) ePrivacy Directive).
        </Typography>
      </Section>

      <Section title="8. Server-Side Caching and Databases">
        <Typography>
          To improve performance and reduce load on third-party APIs, our server caches API
          responses in Redis (an in-memory data store). Cached data typically includes map search
          results, transit schedules, routing responses, and catalog data from external registries.
          Cache entries expire automatically (usually within minutes to 48 hours). The cache does
          not store personal data such as IP addresses or account information.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          We also operate a PostgreSQL database for user accounts, saved places, and cached place
          enrichment data (e.g., Wikidata facts, Wikipedia summaries). If GTFS transit feeds are
          imported, schedule data (stop names, routes, departure times) is stored in separate
          database schemas. None of this data constitutes personal data of end users.
        </Typography>
      </Section>

      <Section title="9. Email Communication">
        <Typography>If you register an account, we may send transactional emails for:</Typography>
        <ul>
          <li>
            <Typography>Email address verification</Typography>
          </li>
          <li>
            <Typography>Password reset requests</Typography>
          </li>
          <li>
            <Typography>Two-factor authentication codes</Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          These emails are sent via an SMTP server and contain only information necessary for the
          respective action. We do not send newsletters or marketing emails. The legal basis is
          Art.&nbsp;6(1)(b) GDPR (performance of a contract / provision of the service you
          requested).
        </Typography>
      </Section>

      <Section title="10. Your Rights Under the GDPR">
        <Typography>You have the following rights regarding your personal data:</Typography>
        <ul>
          <li>
            <Typography>
              <strong>Right of access</strong> (Art. 15 GDPR) — You can request information about
              which personal data we process.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Right to rectification</strong> (Art. 16 GDPR) — You can request correction of
              inaccurate data.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Right to erasure</strong> (Art. 17 GDPR) — You can request deletion of your
              data. You can also delete your account directly in the account settings.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Right to restriction of processing</strong> (Art. 18 GDPR) — You can request
              that we restrict the processing of your data.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Right to data portability</strong> (Art. 20 GDPR) — You can request to receive
              your data in a structured, commonly used, machine-readable format.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Right to object</strong> (Art. 21 GDPR) — You can object to processing based
              on legitimate interests at any time.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Right to withdraw consent</strong> (Art. 7(3) GDPR) — Where processing is
              based on consent (e.g., geolocation), you can withdraw it at any time by revoking the
              browser permission.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          To exercise any of these rights, contact us at the email address listed above. You also
          have the right to lodge a complaint with a supervisory authority (Art. 77 GDPR). The
          competent supervisory authority is: Landesbeauftragte f&uuml;r Datenschutz und
          Informationsfreiheit Nordrhein-Westfalen (LDI NRW), Kavalleriestr.&nbsp;2&ndash;4, 40213
          D&uuml;sseldorf,{" "}
          <Link href="https://www.ldi.nrw.de" target="_blank" rel="noopener noreferrer">
            www.ldi.nrw.de
          </Link>
          .
        </Typography>
      </Section>

      <Section title="11. Data Retention">
        <Typography>We retain personal data only as long as necessary:</Typography>
        <ul>
          <li>
            <Typography>
              <strong>Account data</strong> — retained until you delete your account.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Saved places</strong> — retained until you remove them or delete your account.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Server logs</strong> — automatically deleted after 30 days.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Cache data</strong> — automatically expires within minutes to 48 hours.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Local storage and Service Worker cache</strong> — remains on your device until
              you clear your browser data or the cache entries expire automatically.
            </Typography>
          </li>
        </ul>
      </Section>

      <Section title="12. Security">
        <Typography>
          We implement appropriate technical and organizational measures to protect your data,
          including encrypted connections (TLS/HTTPS), hashed passwords (using modern key-derivation
          functions), secure session management, and parameterized database queries. However, no
          method of transmission over the Internet is 100% secure.
        </Typography>
      </Section>

      <Section title="13. Children's Privacy">
        <Typography>
          OpenMapX is not directed at children under the age of 16. We do not knowingly collect
          personal data from children. If you believe that a child has provided us with personal
          data, please contact us so we can delete it.
        </Typography>
      </Section>

      <Section title="14. Changes to This Policy">
        <Typography>
          We may update this privacy policy from time to time. The current version is always
          available at <Link href="/privacy">/privacy</Link>. Material changes will be indicated by
          updating the &quot;Last updated&quot; date.
        </Typography>
      </Section>
    </Box>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box id={sectionSlug(title)} sx={{ mb: 4, scrollMarginTop: 16 }}>
      <Typography variant="h6" component="h2" sx={{ fontWeight: 600, mb: 1 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

interface ServiceRow {
  service: string;
  purpose: string;
  dataSent: string;
  country: string;
  privacy: string;
}

function ServiceTable({ rows }: { rows: ServiceRow[] }) {
  return (
    <TableContainer sx={{ mt: 1, mb: 1 }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 600 }}>Service</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Purpose</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Data Transmitted</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Country</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Privacy Info</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.service}>
              <TableCell>{row.service}</TableCell>
              <TableCell>{row.purpose}</TableCell>
              <TableCell>{row.dataSent}</TableCell>
              <TableCell>{row.country}</TableCell>
              <TableCell>
                {row.privacy.startsWith("http") ? (
                  <Link href={row.privacy} target="_blank" rel="noopener noreferrer">
                    Link
                  </Link>
                ) : (
                  <Typography variant="body2">{row.privacy}</Typography>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
