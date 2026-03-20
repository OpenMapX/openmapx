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
          Email: {email}
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
            <Typography>Providing the mapping service (map tiles, search, routing)</Typography>
          </li>
          <li>
            <Typography>User account management (if you create an account)</Typography>
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
              require coordinates (e.g., routing, nearby search)
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
              <strong>Session data</strong> — authentication cookies to keep you signed in
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
      </Section>

      <Section title="6. Third-Party Services and Data Transfers">
        <Typography>
          To provide its mapping features, OpenMapX sends requests to various third-party APIs. When
          you use a feature, certain data (typically map viewport coordinates, search queries, or
          route waypoints) is transmitted to the respective provider. Below is a comprehensive list
          of all external services:
        </Typography>

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 2, mb: 1 }}>
          6.1 Map Tiles and Display
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "MapTiler",
              purpose: "Base map tiles (streets, satellite, terrain)",
              dataSent: "Map viewport coordinates, zoom level",
              country: "Switzerland",
              privacy: "https://www.maptiler.com/privacy-policy/",
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
              dataSent: "Search queries, bounding box",
              country: "Switzerland",
              privacy: "https://www.maptiler.com/privacy-policy/",
            },
            {
              service: "Nominatim (OpenStreetMap Foundation)",
              purpose: "Address search, reverse geocoding, place enrichment",
              dataSent: "Search queries, coordinates",
              country: "UK / Various",
              privacy: "https://osmfoundation.org/wiki/Privacy_Policy",
            },
            {
              service: "Photon (Komoot)",
              purpose: "Address search (alternative provider)",
              dataSent: "Search queries",
              country: "Germany",
              privacy: "https://www.komoot.com/privacy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.3 Routing and Directions
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OSRM (public demo)",
              purpose: "Car route calculation",
              dataSent: "Start/end coordinates, route options",
              country: "Germany",
              privacy: "https://project-osrm.org/",
            },
            {
              service: "Valhalla (FOSSGIS)",
              purpose: "Walking and cycling routes",
              dataSent: "Start/end coordinates, routing mode",
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
              dataSent: "Map tile coordinates",
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
              service: "Mapillary (Meta)",
              purpose: "Street-level photos and coverage",
              dataSent: "Coordinates, bounding box",
              country: "USA",
              privacy: "https://www.mapillary.com/privacy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.6 Public Transit
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "TransitLand",
              purpose: "Transit stops and routes",
              dataSent: "Bounding box, stop/route queries",
              country: "USA",
              privacy: "https://www.transit.land/terms",
            },
            {
              service: "Transitous (MOTIS)",
              purpose: "Multimodal transit trip planning",
              dataSent: "Start/end coordinates, date/time",
              country: "Germany",
              privacy: "https://transitous.org/",
            },
            {
              service: "transport.rest (DB, VBB, BVG)",
              purpose: "German public transit data",
              dataSent: "Station queries, journey requests",
              country: "Germany",
              privacy: "https://transport.rest/",
            },
            {
              service: "Transport for London (TfL)",
              purpose: "London transit data",
              dataSent: "Stop/line queries",
              country: "UK",
              privacy: "https://tfl.gov.uk/corporate/privacy-and-cookies/",
            },
            {
              service: "MBTA",
              purpose: "Boston area transit",
              dataSent: "Stop/prediction queries",
              country: "USA",
              privacy: "https://www.mbta.com/policies/privacy-policy",
            },
            {
              service: "iRail",
              purpose: "Belgian rail data",
              dataSent: "Station/connection queries",
              country: "Belgium",
              privacy: "https://hello.irail.be/privacy/",
            },
            {
              service: "transport.opendata.ch",
              purpose: "Swiss transit data",
              dataSent: "Station/connection queries",
              country: "Switzerland",
              privacy: "https://transport.opendata.ch/",
            },
            {
              service: "Overpass API",
              purpose: "Transit stop data from OpenStreetMap (fallback)",
              dataSent: "Bounding box queries",
              country: "Germany",
              privacy: "https://wiki.openstreetmap.org/wiki/Overpass_API",
            },
            {
              service: "Dynamic transit providers (via public-transport/transport-apis)",
              purpose:
                "Additional regional transit APIs discovered at runtime from an open registry",
              dataSent: "Station/journey queries (varies by provider)",
              country: "Various",
              privacy: "https://github.com/public-transport/transport-apis",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.7 Air Quality
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OpenAQ",
              purpose: "Air quality measurements (PM2.5, AQI)",
              dataSent: "Bounding box",
              country: "USA",
              privacy: "https://openaq.org/privacy/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.8 EV Charging Stations
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OpenChargeMap",
              purpose: "EV charging station locations and details",
              dataSent: "Bounding box, filter parameters",
              country: "UK",
              privacy: "https://openchargemap.org/site/profile/privacy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.9 Fuel Prices
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Tankerkoenig",
              purpose: "German fuel station prices",
              dataSent: "Bounding box",
              country: "Germany",
              privacy: "https://creativecommons.tankerkoenig.de/",
            },
            {
              service: "French / Spanish / Austrian government fuel APIs",
              purpose: "Regional fuel price data",
              dataSent: "Bounding box or region identifiers",
              country: "France / Spain / Austria",
              privacy: "Respective government open data portals",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.10 Shared Mobility (Bikes, Scooters, Car-Sharing)
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Deutsche Bahn GBFS",
              purpose: "German bike-sharing (Call-a-Bike, StadtRad)",
              dataSent: "Bounding box",
              country: "Germany",
              privacy: "https://www.bahn.de/datenschutz",
            },
            {
              service: "Citybikes API",
              purpose: "Global bike-sharing station data",
              dataSent: "Bounding box",
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
              service: "Cambio",
              purpose: "Car-sharing availability",
              dataSent: "Bounding box",
              country: "Germany / Belgium",
              privacy: "https://www.cambio-carsharing.de/datenschutz",
            },
            {
              service: "Felyx, Link, GO Sharing, Donkey Republic",
              purpose: "E-scooter and bike-sharing locations",
              dataSent: "Coordinates or bounding box",
              country: "Various (EU)",
              privacy: "See respective provider websites",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.11 Place Enrichment
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Wikidata / Wikipedia / Wikimedia Commons",
              purpose: "Place descriptions, photos, structured facts",
              dataSent: "Place identifiers, search queries",
              country: "USA (Wikimedia Foundation)",
              privacy: "https://foundation.wikimedia.org/wiki/Privacy_policy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.12 Authentication Providers
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OpenStreetMap OAuth",
              purpose: "User sign-in via OSM account",
              dataSent: "OAuth authorization flow (no password shared)",
              country: "UK",
              privacy: "https://osmfoundation.org/wiki/Privacy_Policy",
            },
            {
              service: "Mapillary OAuth",
              purpose: "User sign-in via Mapillary account",
              dataSent: "OAuth authorization flow (no password shared)",
              country: "USA",
              privacy: "https://www.mapillary.com/privacy",
            },
          ]}
        />

        <Typography sx={{ mt: 2 }}>
          <strong>International transfers:</strong> Some of the above services are operated by
          entities in the USA or other countries outside the European Economic Area (EEA). Where
          data is transferred to third countries, we rely on the EU-U.S. Data Privacy Framework,
          Standard Contractual Clauses, or the provider&apos;s compliance with equivalent safeguards
          pursuant to Art. 46 GDPR. The legal basis for all third-party service requests is Art.
          6(1)(f) GDPR (legitimate interest in providing the mapping service you are using).
        </Typography>
      </Section>

      <Section title="7. Cookies and Local Storage">
        <Typography>OpenMapX uses only technically necessary storage mechanisms:</Typography>
        <ul>
          <li>
            <Typography>
              <strong>Session cookies</strong> — If you sign in, a session cookie is set to
              authenticate your requests. This cookie is essential for the login functionality and
              is deleted when you sign out or when it expires.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Service Worker cache</strong> — In production, a Service Worker caches static
              assets (HTML, CSS, JavaScript) for offline availability. No personal data is stored.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Browser memory cache</strong> — API responses (search results, routes) are
              cached in browser memory during your session for performance. This data is discarded
              when you close the tab.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          We do <strong>not</strong> use any tracking cookies, analytics cookies, or advertising
          cookies. No cookie consent banner is required because we only use technically necessary
          cookies (Section 25(2) TDDDG).
        </Typography>
      </Section>

      <Section title="8. Server-Side Caching">
        <Typography>
          To improve performance and reduce load on third-party APIs, our server caches API
          responses in Redis (an in-memory data store). Cached data typically includes map search
          results, transit schedules, and routing responses. Cache entries expire automatically
          (usually within minutes to 24 hours). The cache does not store personal data such as IP
          addresses or account information.
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
          respective action. We do not send newsletters or marketing emails.
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
          competent authority in Germany is the data protection authority of the federal state in
          which the controller is based.
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
              <strong>Server logs</strong> — automatically deleted after 30 days.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Cache data</strong> — automatically expires within minutes to 48 hours.
            </Typography>
          </li>
        </ul>
      </Section>

      <Section title="12. Security">
        <Typography>
          We implement appropriate technical and organizational measures to protect your data,
          including encrypted connections (TLS/HTTPS), hashed passwords, and secure session
          management. However, no method of transmission over the Internet is 100% secure.
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
