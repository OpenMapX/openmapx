import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { legalConfig, sectionSlug } from "@openmapx/core/server";
import { generatePrivacySectionsFromManifests } from "../generateLegalSections";

export default function PrivacyContent({
  capabilities: _capabilities = {},
  integrations = [],
}: {
  capabilities?: Record<string, boolean>;
  integrations?: import("@openmapx/core").LoadedIntegrationMeta[];
}) {
  const { name, street, postalCode, city, country, email } = legalConfig;

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 1 }}>
        Privacy Policy
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
        Last updated: April 2026
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

        {generatePrivacySectionsFromManifests(integrations, "en").map((section) => (
          <div key={section.key}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
              {section.labelEn}
            </Typography>
            <ServiceTable rows={section.rows} />
          </div>
        ))}

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          Authentication Providers
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
          Software Registries and Catalogs
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "GitHub API (Microsoft)",
              purpose:
                "Fetching transit API registry and GTFS feed catalog from open-source repositories (server-side only)",
              dataSent: "No user data (server-side repository file lookups)",
              country: "USA",
              privacy:
                "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement",
            },
          ]}
        />

        <Typography sx={{ mt: 2 }}>
          <strong>Note on data flow:</strong> The &quot;Data Access&quot; column above indicates how
          each service is contacted. &quot;Server-only&quot; and &quot;Proxied (server)&quot; mean
          requests are routed through our backend server — the third-party provider only sees our
          server&apos;s IP address, not yours. &quot;Direct (browser)&quot; means your browser
          connects directly to the provider, exposing your IP address and browser fingerprint to
          them. The vast majority of services are server-only or proxied.
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
          knowledge data (e.g., Wikidata facts, Wikipedia summaries). If GTFS transit feeds are
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
  endUserExposure?: string;
}

function ServiceTable({ rows }: { rows: ServiceRow[] }) {
  const hasExposure = rows.some((r) => r.endUserExposure);
  return (
    <TableContainer sx={{ mt: 1, mb: 1 }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 600 }}>Service</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Purpose</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Data Transmitted</TableCell>
            {hasExposure && <TableCell sx={{ fontWeight: 600 }}>Data Access</TableCell>}
            <TableCell sx={{ fontWeight: 600 }}>Country</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Privacy Info</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.service}-${row.country}-${row.purpose}`}>
              <TableCell>{row.service}</TableCell>
              <TableCell>{row.purpose}</TableCell>
              <TableCell>{row.dataSent}</TableCell>
              {hasExposure && <TableCell>{row.endUserExposure}</TableCell>}
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
