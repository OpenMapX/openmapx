import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import type { Disclosure, PublicLegalConfig } from "@openmapx/core/server";
import { legalConfig, sectionSlug } from "@openmapx/core/server";
import { emailCountryName, emailTransferNote } from "../emailDisclosure";
import { generatePrivacySectionsFromManifests } from "../generateLegalSections";
import { privacyTitles } from "./sections";

export default function PrivacyContent({
  capabilities: _capabilities = {},
  integrations = [],
  disclosures = [],
  legal,
}: {
  capabilities?: Record<string, boolean>;
  integrations?: import("@openmapx/integration-framework").LoadedIntegrationMeta[];
  disclosures?: Disclosure[];
  legal?: PublicLegalConfig;
}) {
  const {
    name,
    street,
    postalCode,
    city,
    country,
    email,
    supervisoryAuthority: supervisoryAuthorityEnv,
    supervisoryAuthorityUrl: supervisoryAuthorityUrlEnv,
    hostingProvider: hostingProviderEnv,
    hostingLocations: hostingLocationsEnv,
    serverLogRetentionDays: serverLogRetentionDaysEnv,
  } = legalConfig;
  // Hosting, supervisory authority and log retention resolve env > admin-
  // database > default in app-api and arrive via `legal`. Fall back to the
  // web-process env (legalConfig) only when the API is unreachable during SSR,
  // so a configured value still renders.
  const hostingProvider = legal?.hostingProvider || hostingProviderEnv;
  const hostingLocations = legal?.hostingLocations || hostingLocationsEnv;
  const supervisoryAuthority = legal?.supervisoryAuthority || supervisoryAuthorityEnv;
  const supervisoryAuthorityUrl = legal?.supervisoryAuthorityUrl || supervisoryAuthorityUrlEnv;
  const serverLogRetentionDays = legal?.serverLogRetentionDays ?? serverLogRetentionDaysEnv;
  const T = privacyTitles("en");

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 1 }}>
        Privacy Policy
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mb: 4,
        }}
      >
        Last updated: July 22, 2026
      </Typography>
      <Section title={T.controller}>
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
        <Typography sx={{ mt: 1 }}>
          We are not legally required to appoint a Data Protection Officer and have therefore not
          designated one. For any data-protection matters, you can reach us at the email address
          above.
        </Typography>
      </Section>
      <Section title={T.overview}>
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
      <Section title={T.hosting}>
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
          service). Server logs are automatically deleted after {serverLogRetentionDays} days.
        </Typography>
        {hostingProvider && (
          <Typography sx={{ mt: 1 }}>
            Our servers are hosted by {hostingProvider}, who processes data on our behalf and
            exclusively according to our instructions (data processor pursuant to Art.&nbsp;28
            GDPR). A data processing agreement is in place.
            {hostingLocations ? ` The data centers are located in ${hostingLocations}.` : ""}
          </Typography>
        )}
      </Section>
      <Section title={T.geolocation}>
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
      <Section title={T.accounts}>
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
          <li>
            <Typography>
              <strong>Mangrove review keypair</strong> — if you opt in to the review feature, an
              ECDSA P-256 signing keypair is generated and stored for you. The public key is stored
              in cleartext on our server (it is, by design, public). The private key is stored
              according to the protection mode you choose:
            </Typography>
            <ul>
              <li>
                <Typography>
                  <strong>Passphrase (recommended)</strong> — the private key is encrypted in your
                  browser with a passphrase you choose, using the audited{" "}
                  <Link
                    href="https://age-encryption.org/v1"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    age encryption
                  </Link>{" "}
                  format (scrypt key-stretching plus ChaCha20-Poly1305). We only ever see the
                  ciphertext.
                </Typography>
              </li>
              <li>
                <Typography>
                  <strong>Passphrase and/or WebAuthn passkey</strong> — you may additionally or
                  alternatively unlock the private key with one or more registered passkeys (e.g.
                  your phone&apos;s biometrics, a hardware security key). We store one
                  age-plugin-fido2prf identity string per passkey. That string encodes the
                  credential id, relying-party id and transport hint — it contains no secret
                  material.
                </Typography>
              </li>
              <li>
                <Typography>
                  <strong>Unencrypted (explicit opt-in)</strong> — only if you actively choose this,
                  the private key is stored in cleartext on our server. In this mode, anyone with
                  access to the database (including the operator) could cryptographically sign
                  reviews in your name. We show a warning before you make this choice.
                </Typography>
              </li>
            </ul>
          </li>
          <li>
            <Typography>
              <strong>Review content</strong> — if you submit a review, the content you provide
              (rating, free-text review, optional images, optional affiliations, optional experience
              context, place reference) is cryptographically signed in your browser and then
              forwarded by our server to the Mangrove.reviews network. See Section&nbsp;6 below for
              the publication model.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          You may also sign in via third-party OAuth providers (OpenStreetMap, Mapillary). In that
          case, we receive your public profile information (name, profile picture URL) from the
          respective provider. Your browser is redirected directly to the selected provider during
          authorization, so that provider may receive your IP address and browser request metadata.
          We do not receive or store your password for these providers.
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
      <Section title={T.reviews}>
        <Typography>
          OpenMapX integrates the{" "}
          <Link href="https://mangrove.reviews/" target="_blank" rel="noopener noreferrer">
            Mangrove.reviews
          </Link>{" "}
          decentralized review network (Open Reviews Standard, operated by the Open Reviews
          Association, Z&uuml;rich, Switzerland). Using the review feature has privacy implications
          that go beyond our own servers, so please read this section carefully before submitting a
          review.
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Reviews are public and permanent.</strong> When you submit a review, it is
              cryptographically signed with your keypair (see Section&nbsp;5) and published to{" "}
              <code>api.mangrove.reviews</code>. From there it is mirrored and re-published by
              independent aggregators we do not control. Deletion of a review is a best-effort
              request to aggregators; we cannot guarantee removal from all copies already
              propagated.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Your public key is a persistent pseudonym.</strong> Every review you submit is
              signed with, and linked to, your public key. The public key is stored in cleartext by
              Mangrove and aggregators and ties all of your reviews together into a pseudonymous
              identity, even across sessions and devices. Anyone who learns a connection between
              your public key and your real-world identity can link it to all prior and future
              reviews you sign. The key is not a direct identifier (name, email, etc.), but treating
              it as anonymous would be misleading.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>What is submitted.</strong> Each review submission contains: the subject
              identifier (for places this is a <code>geo:</code> URI with the place&apos;s
              coordinates and uncertainty radius), your rating, optional free-text opinion, optional
              experience tags, optional affiliation disclosures, optional uploaded images, your
              public key, and your signature.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Image uploads.</strong> Optional review images are uploaded to Mangrove&apos;s
              image service (<code>files.mangrove.reviews</code>). Images are served publicly once
              uploaded. Before your image leaves your browser, we re-encode it through an HTML
              canvas to strip EXIF, XMP, IPTC, GPS and similar embedded metadata that cameras often
              attach. The visible pixel content of the photo itself is retained and published as-is.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Reading reviews.</strong> When you view a place in OpenMapX, our backend
              fetches any existing reviews for that place from <code>api.mangrove.reviews</code>,
              forwarding the place&apos;s <code>geo:</code> URI (coordinates). Your IP address is
              not transmitted to Mangrove for read operations because these go through our server.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Editing and deleting your own reviews.</strong> Edits and deletions are
              themselves signed follow-up reviews. They are propagated in the same way as the
              original review and are subject to the same caveats about mirrors and retention by
              third parties.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          The legal basis for the storage and signing of your keypair is Art.&nbsp;6(1)(b) GDPR
          (performance of the review service you requested). The legal basis for the publication of
          review content to the Mangrove network is Art.&nbsp;6(1)(a) GDPR (your explicit consent,
          given when you accept the in-app Terms/Privacy checkboxes in the review dialog and press
          &ldquo;Publish&rdquo;). You may withdraw future consent at any time by not publishing
          further reviews; already-published reviews cannot be unpublished unilaterally because of
          the decentralized design of the system. Where your review is thereby transferred to
          aggregators in countries outside the European Economic Area (EEA), that transfer is based
          on your explicit consent pursuant to Art.&nbsp;49(1)(a) GDPR.
        </Typography>
      </Section>
      <Section title={T.thirdParty}>
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
          Core Map Rendering
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "MapTiler Cloud",
              purpose:
                "Base map style, vector tiles, satellite tiles, and font glyphs when MapTiler is configured as the map provider",
              dataSent:
                "Map asset requests and tile coordinates sent by our backend proxy; may reflect the visible map area",
              endUserExposure: "Proxied (server)",
              country: "Switzerland",
              privacy: "https://www.maptiler.com/privacy-policy/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          Authentication Providers
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OpenStreetMap OAuth 2.0",
              purpose: "User sign-in via OSM account",
              dataSent:
                "Browser redirect to OSM authorization page; OAuth authorization flow (no password shared with us)",
              endUserExposure: "Direct (browser)",
              country: "UK",
              privacy: "https://osmfoundation.org/wiki/Privacy_Policy",
            },
            {
              service: "Mapillary OAuth (Meta Platforms)",
              purpose: "User sign-in via Mapillary account",
              dataSent:
                "Browser redirect to Mapillary authorization page; OAuth authorization flow (no password shared with us)",
              endUserExposure: "Direct (browser)",
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
              endUserExposure: "Server-only",
              country: "USA",
              privacy:
                "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement",
            },
          ]}
        />

        {(() => {
          const cloudVendors = [
            ...new Set(
              disclosures.flatMap((d) =>
                d.type === "ai-search" && d.cloudActive ? d.cloudVendors : [],
              ),
            ),
          ];
          if (cloudVendors.length === 0) return null;
          return (
            <>
              <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
                AI Query Interpretation (Cloud)
              </Typography>
              <ServiceTable
                rows={[
                  ...(cloudVendors.includes("anthropic")
                    ? [
                        {
                          service: "Anthropic (Claude)",
                          purpose:
                            "Interpret your natural-language search query into a structured search",
                          dataSent:
                            "Your search query text and approximate map center (rounded coordinates)",
                          endUserExposure: "Server-only",
                          country: "USA",
                          privacy: "https://www.anthropic.com/legal/privacy",
                        },
                      ]
                    : []),
                  ...(cloudVendors.includes("openai")
                    ? [
                        {
                          service: "OpenAI",
                          purpose:
                            "Interpret your natural-language search query into a structured search",
                          dataSent:
                            "Your search query text and approximate map center (rounded coordinates)",
                          endUserExposure: "Server-only",
                          country: "USA",
                          privacy: "https://openai.com/policies/privacy-policy/",
                        },
                      ]
                    : []),
                ]}
              />
              <Typography variant="body2" sx={{ mt: 1 }}>
                These providers are based in the USA. The transfer is made on the basis of the EU
                Standard Contractual Clauses (Art.&nbsp;46(2)(c) GDPR); where a provider is
                certified under the EU-U.S. Data Privacy Framework, the transfer additionally relies
                on the European Commission&apos;s adequacy decision.
              </Typography>
            </>
          );
        })()}

        <Typography sx={{ mt: 2 }}>
          <strong>Note on data flow:</strong> The &quot;Data Access&quot; column above indicates how
          each service is contacted. &quot;Server-only&quot; and &quot;Proxied (server)&quot; mean
          requests are routed through our backend server — the third-party provider only sees our
          server&apos;s IP address, not yours. &quot;Direct (browser)&quot; means your browser
          connects directly to the provider, exposing your IP address and browser fingerprint to
          them. &quot;Mixed&quot; means catalog or metadata requests are server-side or proxied, but
          specific media/player assets may be loaded directly by your browser after you take an
          explicit action, such as confirming a viewer notice or clicking &quot;Load media&quot;.
          The vast majority of services are server-only or proxied. MapTiler map assets are routed
          through our API proxy by default. If an operator configures public map, style, or tile URL
          templates to point at external providers, your browser will contact those configured
          providers directly for those assets.
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
              street-level imagery viewer (Meta Platforms, Inc.) is loaded only after you confirm an
              in-app notice. It then connects directly from your browser, exposing your IP address,
              browser/device request metadata, selected image ID, and viewed coordinates. Some
              webcam video/player providers may also receive your IP address when you click
              &quot;Load media&quot; or otherwise open the live media. Meta is certified under the
              EU-U.S. Data Privacy Framework (DPF).
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Proxied requests to non-EEA providers:</strong> MapTiler Cloud receives
              proxied map asset requests when it is configured as the map provider. MapTiler AG is
              based in Switzerland, which has an EU adequacy decision.
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
      <Section title={T.cookies}>
        <Typography>
          OpenMapX uses first-party storage mechanisms only. Storage that is necessary for the
          service is used without a consent banner. The optional recent map-data cache is disabled
          by default and is only enabled when you switch it on in Settings.
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
              CSS, JavaScript), map tiles, and downloaded offline areas using the browser&apos;s
              Cache Storage API. This enables offline functionality and faster loading. Cached
              entries expire automatically (static assets: 30 days; map tiles: 3&ndash;7 days).
              Runtime API response caches for search, route, place, autocomplete, weather, and photo
              lookups are only written when you enable the recent map-data cache.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Browser memory cache</strong> — API responses are additionally cached in
              browser memory (via TanStack Query) during your session for performance. This data is
              discarded when you close the tab.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Optional recent map-data cache</strong> — If you enable &quot;Remember recent
              map data on this device&quot; in Settings, OpenMapX stores a curated set of recent
              map-related API responses in localStorage and Cache Storage. This can include typed
              search text, route waypoints, place details, weather lookups, photo lookup results,
              nearby results, and exact map coordinates. Entries expire automatically according to
              their cache type (usually within minutes to 24 hours; photo lookup caches can remain
              for up to 7 days). You can disable the setting or clear this data at any time in the
              Storage settings.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          We do <strong>not</strong> use any tracking cookies, analytics cookies, or advertising
          cookies. No cookie consent banner is required for strictly necessary storage
          (&sect;&nbsp;25(2)&nbsp;TDDDG, implementing Art.&nbsp;5(3) ePrivacy Directive). The
          optional recent map-data cache is off by default and is controlled through an explicit
          first-party setting rather than a tracking banner.
        </Typography>
      </Section>
      <Section title={T.caching}>
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
      <Section title={T.email}>
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
        {(() => {
          const email = disclosures.find((d) => d.type === "email");
          const country = email ? emailCountryName(email.countryCode, "en") : "";
          const transferNote = email ? emailTransferNote(email.transfer, "en") : "";
          return (
            <Typography sx={{ mt: 1 }}>
              {email?.vendorName ? (
                <>
                  These emails are sent via {email.vendorName}
                  {country ? ` (${country})` : ""} &mdash; a service provider acting on our behalf
                  and strictly on our instructions (a processor under Art.&nbsp;28 GDPR)
                  {email.privacyUrl ? (
                    <>
                      {" "}
                      <Link href={email.privacyUrl} target="_blank" rel="noopener noreferrer">
                        (privacy notice)
                      </Link>
                    </>
                  ) : null}
                  .{transferNote ? ` ${transferNote}` : ""}{" "}
                </>
              ) : (
                <>These emails are sent via an SMTP server we operate or commission. </>
              )}
              They contain only information necessary for the respective action. We do not send
              newsletters or marketing emails. The legal basis is Art.&nbsp;6(1)(b) GDPR
              (performance of a contract / provision of the service you requested).
            </Typography>
          );
        })()}
      </Section>
      <Section title={T.rights}>
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
          have the right to lodge a complaint with a supervisory authority (Art. 77 GDPR).
          {supervisoryAuthority && (
            <>
              {" "}
              The competent supervisory authority is: {supervisoryAuthority}
              {supervisoryAuthorityUrl && (
                <>
                  ,{" "}
                  <Link href={supervisoryAuthorityUrl} target="_blank" rel="noopener noreferrer">
                    {supervisoryAuthorityUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")}
                  </Link>
                </>
              )}
              .
            </>
          )}
        </Typography>
        <Typography sx={{ mt: 1 }}>
          <strong>No automated decision-making.</strong> We do not use your personal data for
          automated decision-making, including profiling, within the meaning of Art.&nbsp;22 GDPR.
        </Typography>
      </Section>
      <Section title={T.retention}>
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
              <strong>Mangrove keypair</strong> — retained until you regenerate it or delete your
              account. Deleting the keypair on our servers does <strong>not</strong> retract
              previously published reviews from the Mangrove network.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Published review content</strong> — lives on the Mangrove network and its
              mirrors, outside our control. Within OpenMapX&apos;s own display, reviews can be
              hidden upon request; on external aggregators, retention is governed by their
              respective policies.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Server logs</strong> — automatically deleted after {serverLogRetentionDays}{" "}
              days.
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
      <Section title={T.security}>
        <Typography>
          We implement appropriate technical and organizational measures to protect your data,
          including encrypted connections (TLS/HTTPS), hashed passwords (using modern key-derivation
          functions), secure session management, and parameterized database queries. However, no
          method of transmission over the Internet is 100% secure.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          <strong>Trust model for the Mangrove keypair (Section&nbsp;5).</strong> In passphrase mode
          and passphrase + passkey mode, the private signing key never leaves your browser in
          cleartext. Even a full compromise of our database would only reveal age-encrypted
          ciphertext, which cannot be decrypted without your passphrase or a registered passkey. In
          contrast, the &ldquo;unencrypted&rdquo; opt-in mode stores the private key in cleartext;
          anyone with database access could therefore sign reviews in your name. We recommend
          choosing one of the encrypted modes and never sharing your passphrase.
        </Typography>
      </Section>
      <Section title={T.children}>
        <Typography>
          OpenMapX is not directed at children under the age of 16. We do not knowingly collect
          personal data from children. If you believe that a child has provided us with personal
          data, please contact us so we can delete it.
        </Typography>
      </Section>
      <Section title={T.changes}>
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
            <TableRow
              key={`${row.service}-${row.country}-${row.purpose}-${row.dataSent}-${row.privacy}`}
            >
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
