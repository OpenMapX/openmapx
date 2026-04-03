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
import { TransitFeedAttribution } from "@/components/legal/TransitFeedAttribution";
import { generateAttributionSectionsFromManifests } from "../generateLegalSections";

export default function TermsContent({
  transitAttribution = [],
  capabilities: _capabilities = {},
  integrations = [],
}: {
  transitAttribution?: unknown[];
  capabilities?: Record<string, boolean>;
  integrations?: import("@openmapx/core").LoadedIntegrationMeta[];
}) {
  const { name, street, postalCode, city, country, email, jurisdictionCity } = legalConfig;

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 1 }}>
        Terms of Service
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
        Last updated: March 2026
      </Typography>

      <Section title="1. Scope and Provider">
        <Typography>
          These Terms of Service (&quot;Terms&quot;) govern your use of OpenMapX, an open-data
          mapping platform operated by:
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
          By accessing or using OpenMapX, you agree to these Terms. If you do not agree, please do
          not use the service.
        </Typography>
      </Section>

      <Section title="2. Description of the Service">
        <Typography>
          OpenMapX is a free, open-data mapping service that provides map viewing, address search,
          route planning (including isochrones and elevation profiles), public transit information,
          street-level imagery, place photos and enrichment data, live traffic overlays, air quality
          data, wildfire and earthquake monitoring, hiking and outdoor trail information, parking
          availability, EV charging station locations, fuel prices, shared mobility data
          (bike-sharing, e-scooters, car-sharing), and general place information. The service
          aggregates data from multiple open-data sources and third-party APIs as listed in Section
          10 below.
        </Typography>
      </Section>

      <Section title="3. Availability and Changes">
        <Typography>
          OpenMapX is provided on an &quot;as is&quot; and &quot;as available&quot; basis. We strive
          to keep the service running, but we do not guarantee uninterrupted or error-free
          availability. We reserve the right to modify, suspend, or discontinue any part of the
          service at any time without prior notice.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Since we depend on numerous third-party data sources, individual features may become
          unavailable if upstream providers change their APIs, terms, or availability.
        </Typography>
      </Section>

      <Section title="4. User Accounts">
        <Typography>
          Account creation is optional. You can use most features of OpenMapX without an account. If
          you create an account:
        </Typography>
        <ul>
          <li>
            <Typography>
              You are responsible for maintaining the confidentiality of your login credentials.
            </Typography>
          </li>
          <li>
            <Typography>
              You agree to provide accurate information and to keep it up to date.
            </Typography>
          </li>
          <li>
            <Typography>
              You are responsible for all activity that occurs under your account.
            </Typography>
          </li>
          <li>
            <Typography>
              You may delete your account at any time through the account settings.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          You must be at least 16 years old to create an account. By creating an account, you
          confirm that you meet this age requirement.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          We reserve the right to suspend or terminate accounts that violate these Terms.
        </Typography>
      </Section>

      <Section title="5. Acceptable Use">
        <Typography>You agree not to:</Typography>
        <ul>
          <li>
            <Typography>
              Use the service for any unlawful purpose or in violation of applicable laws.
            </Typography>
          </li>
          <li>
            <Typography>
              Systematically scrape, harvest, or extract data from the service beyond normal
              personal use.
            </Typography>
          </li>
          <li>
            <Typography>
              Attempt to interfere with, disrupt, or gain unauthorized access to the service or its
              infrastructure.
            </Typography>
          </li>
          <li>
            <Typography>
              Use automated tools (bots, crawlers) to access the service at a rate that degrades the
              experience for other users.
            </Typography>
          </li>
          <li>
            <Typography>
              Reverse engineer, decompile, or attempt to extract the source code of the service.
            </Typography>
          </li>
          <li>
            <Typography>
              Impersonate another person or entity or misrepresent your affiliation.
            </Typography>
          </li>
          <li>
            <Typography>
              Circumvent rate limits, access controls, or other security measures implemented by the
              service or its upstream data providers.
            </Typography>
          </li>
        </ul>
      </Section>

      <Section title="6. Accuracy and No Warranty">
        <Typography>
          OpenMapX aggregates data from third-party sources. While we strive for accuracy, we make
          no warranties or representations regarding the completeness, accuracy, reliability, or
          timeliness of any data displayed, including but not limited to:
        </Typography>
        <ul>
          <li>
            <Typography>Map data, place names, and geographic coordinates</Typography>
          </li>
          <li>
            <Typography>Route calculations, travel times, and distances</Typography>
          </li>
          <li>
            <Typography>Isochrone areas and elevation profiles</Typography>
          </li>
          <li>
            <Typography>
              Public transit schedules, real-time arrivals, and service alerts
            </Typography>
          </li>
          <li>
            <Typography>Fuel prices, EV charging station availability, and pricing</Typography>
          </li>
          <li>
            <Typography>Air quality measurements and environmental indices</Typography>
          </li>
          <li>
            <Typography>
              Wildfire detections, earthquake data, and other natural disaster information
            </Typography>
          </li>
          <li>
            <Typography>
              Hiking trail information, difficulty ratings, and shelter availability
            </Typography>
          </li>
          <li>
            <Typography>Parking lot occupancy and capacity data</Typography>
          </li>
          <li>
            <Typography>Shared mobility vehicle availability and locations</Typography>
          </li>
          <li>
            <Typography>Street-level imagery and place photos</Typography>
          </li>
          <li>
            <Typography>Business hours, contact information, and place details</Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          <strong>
            Do not rely on OpenMapX for safety-critical decisions, emergency navigation, disaster
            response, or situations where inaccurate information could lead to harm. In particular,
            wildfire and earthquake data may be delayed or incomplete and must not be used as a
            substitute for official emergency alerts.
          </strong>
        </Typography>
        <Typography sx={{ mt: 1 }}>
          OpenMapX is a free service that relies entirely on third-party data sources beyond the
          operator&apos;s control. The operator does not guarantee uninterrupted availability,
          error-free operation, or the accuracy of any data displayed. Your statutory rights remain
          unaffected.
        </Typography>
      </Section>

      <Section title="7. Limitation of Liability">
        <Typography>The operator&apos;s liability is governed as follows:</Typography>
        <ul>
          <li>
            <Typography>
              <strong>Unlimited liability.</strong> The operator is liable without limitation for
              damages caused by intent or gross negligence, for damages resulting from injury to
              life, body, or health, and for any other liability that cannot be excluded or limited
              under applicable law.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Essential contractual obligations.</strong> In cases of simple negligence, the
              operator is liable only for breaches of essential contractual obligations (obligations
              whose fulfilment is a prerequisite for the proper performance of the contract and on
              whose compliance the user may regularly rely). In such cases, liability is limited to
              the foreseeable, typically occurring damages.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Other negligence.</strong> Liability for simple negligence in all other cases
              is excluded.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          The above limitations also apply in favour of the operator&apos;s employees,
          representatives, and vicarious agents.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          OpenMapX aggregates data from third-party sources. Given that the service is provided free
          of charge and relies on external data beyond the operator&apos;s control, the operator
          does not guarantee the accuracy, completeness, or timeliness of any data displayed.
        </Typography>
      </Section>

      <Section title="8. Intellectual Property">
        <Typography>
          The OpenMapX application code, design, and branding are the property of the operator. The
          map data, transit information, and other content displayed through the service is sourced
          from third parties and is subject to their respective licenses (see Section 10 below).
        </Typography>
        <Typography sx={{ mt: 1 }}>
          You may not use the OpenMapX name, logo, or branding without prior written consent.
        </Typography>
      </Section>

      <Section title="9. Privacy">
        <Typography>
          Your use of OpenMapX is also governed by our <Link href="/privacy">Privacy Policy</Link>,
          which describes how we collect, use, and protect your data.
        </Typography>
      </Section>

      <Section title="10. Data Sources and Attribution" id="data-sources">
        <Typography>
          OpenMapX is built on open data. We gratefully acknowledge the following data sources and
          their respective licenses. Where a license applies, clicking the license name will take
          you to the full license text.
        </Typography>

        {generateAttributionSectionsFromManifests(integrations, "en").map((section) => (
          <AttributionTable key={section.heading} heading={section.heading} rows={section.rows} />
        ))}

        <TransitFeedAttribution
          feeds={transitAttribution as never[]}
          labels={{
            heading: "GTFS Transit Feeds",
            description:
              "Data from {count} transit feeds across {countries} countries, sourced via the Transitous catalog.",
            fallback: (
              <>
                Various transit authorities via the{" "}
                <Link
                  href="https://transitous.org/sources/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Transitous catalog
                </Link>
                . License varies per feed.
              </>
            ),
            source: "Source",
            feedName: "Feed",
            license: "License",
            operators: "Operators",
            feeds: "feeds",
          }}
        />
      </Section>

      <Section title="11. Third-Party Terms">
        <Typography>
          Your use of data displayed through OpenMapX may be subject to the terms and conditions of
          the respective third-party data providers listed above. By using features powered by these
          providers, you also agree to comply with their terms of use where applicable. In
          particular, data sourced from OpenStreetMap is available under the ODbL, which requires
          attribution and share-alike for derivative databases.
        </Typography>
      </Section>

      <Section title="12. Severability">
        <Typography>
          If any provision of these Terms is found to be invalid or unenforceable, the remaining
          provisions shall continue in full force and effect. The invalid provision shall be
          replaced by a valid provision that most closely reflects the original intent.
        </Typography>
      </Section>

      <Section title="13. Governing Law and Jurisdiction">
        <Typography>
          These Terms are governed by the laws of the Federal Republic of Germany, excluding the UN
          Convention on Contracts for the International Sale of Goods (CISG). If you are a consumer
          within the EU, you also retain the protection of mandatory provisions of the law of your
          country of residence. The exclusive jurisdiction for all disputes arising from or in
          connection with these Terms shall be {jurisdictionCity}, Germany, unless mandatory
          consumer protection laws provide otherwise.
        </Typography>
      </Section>

      <Section title="14. Changes to These Terms">
        <Typography>
          We reserve the right to update these Terms at any time. The current version is always
          available at <Link href="/terms">/terms</Link>. We will notify registered users of
          material changes by email at least 30 days before they take effect. If you do not agree
          with the changes, you may stop using the service and delete your account before the
          effective date. Continued use of the service after the notified effective date indicates
          your agreement with the revised Terms.
        </Typography>
      </Section>

      <Section title="15. Language">
        <Typography>
          These Terms are available in German and English. In case of discrepancies between the two
          versions, the German version shall prevail.
        </Typography>
      </Section>

      <Section title="16. Contact">
        <Typography>
          If you have questions about these Terms, please contact us at{" "}
          <Link href={`mailto:${email}`}>{email}</Link>.
        </Typography>
      </Section>
    </Box>
  );
}

function Section({
  title,
  children,
  id,
}: {
  title: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <Box id={id ?? sectionSlug(title)} sx={{ mb: 4, scrollMarginTop: 16 }}>
      <Typography variant="h6" component="h2" sx={{ fontWeight: 600, mb: 1 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

interface AttributionRow {
  source: string;
  desc: string;
  license: string;
  licenseUrl?: string;
  url?: string;
}

function AttributionTable({ heading, rows }: { heading: string; rows: AttributionRow[] }) {
  return (
    <>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
        {heading}
      </Typography>
      <TableContainer sx={{ mb: 1 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 600 }}>Source</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Description</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>License</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.source}-${row.desc}`}>
                <TableCell>
                  {row.url ? (
                    <Link href={row.url} target="_blank" rel="noopener noreferrer">
                      {row.source}
                    </Link>
                  ) : (
                    row.source
                  )}
                </TableCell>
                <TableCell>{row.desc}</TableCell>
                <TableCell>
                  {row.licenseUrl ? (
                    <Link href={row.licenseUrl} target="_blank" rel="noopener noreferrer">
                      {row.license}
                    </Link>
                  ) : (
                    row.license
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  );
}
