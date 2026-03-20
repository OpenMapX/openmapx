import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { legalConfig } from "@/lib/legalConfig";
import { sectionSlug } from "@/lib/sectionSlug";

export default function TermsContent() {
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
          Email: {email}
        </Typography>
        <Typography sx={{ mt: 1 }}>
          By accessing or using OpenMapX, you agree to these Terms. If you do not agree, please do
          not use the service.
        </Typography>
      </Section>

      <Section title="2. Description of the Service">
        <Typography>
          OpenMapX is a free, open-data mapping service that provides map viewing, address search,
          route planning, public transit information, street-level imagery, air quality data, EV
          charging locations, fuel prices, shared mobility data, and place information. The service
          aggregates data from multiple open-data sources and third-party APIs.
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
              Reverse engineer, decompile, or attempt to extract the source code of the service
              beyond what the open-source license permits.
            </Typography>
          </li>
          <li>
            <Typography>
              Impersonate another person or entity or misrepresent your affiliation.
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
            <Typography>Public transit schedules and real-time arrivals</Typography>
          </li>
          <li>
            <Typography>Fuel prices, EV charging station availability, and pricing</Typography>
          </li>
          <li>
            <Typography>Air quality measurements</Typography>
          </li>
          <li>
            <Typography>Shared mobility vehicle availability</Typography>
          </li>
          <li>
            <Typography>Business hours, contact information, and place details</Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          <strong>
            Do not rely on OpenMapX for safety-critical decisions, emergency navigation, or
            situations where inaccurate information could lead to harm.
          </strong>
        </Typography>
        <Typography sx={{ mt: 1 }}>
          To the maximum extent permitted by applicable law, the service is provided without any
          warranty of any kind, whether express, implied, or statutory, including but not limited to
          implied warranties of merchantability, fitness for a particular purpose, and
          non-infringement.
        </Typography>
      </Section>

      <Section title="7. Limitation of Liability">
        <Typography>
          To the maximum extent permitted by applicable law, the operator shall not be liable for
          any indirect, incidental, special, consequential, or punitive damages, or any loss of
          profits or revenues, whether incurred directly or indirectly, or any loss of data, use,
          goodwill, or other intangible losses resulting from:
        </Typography>
        <ul>
          <li>
            <Typography>Your use of or inability to use the service.</Typography>
          </li>
          <li>
            <Typography>
              Any inaccuracy or incompleteness of data provided by the service.
            </Typography>
          </li>
          <li>
            <Typography>
              Unauthorized access to or alteration of your data or transmissions.
            </Typography>
          </li>
          <li>
            <Typography>Any third-party conduct or content on the service.</Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Nothing in these Terms excludes or limits liability for intent or gross negligence, or for
          damages resulting from injury to life, body, or health, or any other liability that cannot
          be excluded or limited under applicable German law.
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
          their respective licenses:
        </Typography>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Map Data
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>OpenStreetMap</strong> — Map data &copy; OpenStreetMap contributors, available
              under the{" "}
              <Link
                href="https://opendatacommons.org/licenses/odbl/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open Data Commons Open Database License (ODbL)
              </Link>
              .
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>MapTiler</strong> — Map tiles and geocoding by{" "}
              <Link href="https://www.maptiler.com/" target="_blank" rel="noopener noreferrer">
                MapTiler
              </Link>
              .
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Routing
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>OSRM</strong> — Open Source Routing Machine, powered by OpenStreetMap data.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Valhalla</strong> — Open-source routing engine by Mapzen / Valhalla
              contributors, hosted by{" "}
              <Link href="https://fossgis.de/" target="_blank" rel="noopener noreferrer">
                FOSSGIS e.V.
              </Link>
              .
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Street-Level Imagery
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Mapillary</strong> — Street-level imagery &copy;{" "}
              <Link href="https://www.mapillary.com/" target="_blank" rel="noopener noreferrer">
                Mapillary
              </Link>{" "}
              contributors, available under CC-BY-SA.
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Traffic
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>TomTom</strong> — Traffic flow data &copy;{" "}
              <Link href="https://www.tomtom.com/" target="_blank" rel="noopener noreferrer">
                TomTom International BV
              </Link>
              .
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Public Transit
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Transitous</strong> — Open multimodal routing, powered by MOTIS.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>TransitLand</strong> — Transit data aggregation by{" "}
              <Link href="https://www.transit.land/" target="_blank" rel="noopener noreferrer">
                Interline Technologies
              </Link>
              .
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>transport.rest</strong> — German transit APIs by Jannis R, available under ISC
              license.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>iRail</strong> — Belgian rail data, open source.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>transport.opendata.ch</strong> — Swiss public transport data.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>TfL</strong> — Powered by TfL Open Data. Contains OS data &copy; Crown
              copyright and database rights.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>MBTA</strong> — Data provided by the Massachusetts Bay Transportation
              Authority.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>GTFS feeds</strong> — Various transit authorities. See the{" "}
              <Link
                href="https://github.com/transitous/transitous"
                target="_blank"
                rel="noopener noreferrer"
              >
                Transitous catalog
              </Link>{" "}
              for individual feed attributions.
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Air Quality
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>OpenAQ</strong> — Air quality data from the{" "}
              <Link href="https://openaq.org/" target="_blank" rel="noopener noreferrer">
                OpenAQ
              </Link>{" "}
              platform, sourced from government monitoring networks worldwide.
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          EV Charging
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>OpenChargeMap</strong> — EV charging data from{" "}
              <Link href="https://openchargemap.org/" target="_blank" rel="noopener noreferrer">
                OpenChargeMap
              </Link>
              , available under CC-BY-SA.
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Fuel Prices
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Tankerkoenig</strong> — German fuel price data under CC BY 4.0, based on data
              from the Markttransparenzstelle f&uuml;r Kraftstoffe (MTS-K).
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Government open data</strong> — French, Spanish, and Austrian fuel prices from
              official government data portals.
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Shared Mobility
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Citybikes</strong> — Global bike-sharing data via{" "}
              <Link href="https://citybik.es/" target="_blank" rel="noopener noreferrer">
                citybik.es
              </Link>
              .
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Deutsche Bahn</strong> — Shared mobility data via DB Open Data.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Nextbike, Cambio, Donkey Republic, Felyx, Link, GO Sharing</strong> — Vehicle
              availability data from respective operators.
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Place Information
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Wikidata</strong> — Structured data under{" "}
              <Link
                href="https://creativecommons.org/publicdomain/zero/1.0/"
                target="_blank"
                rel="noopener noreferrer"
              >
                CC0
              </Link>
              .
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Wikipedia</strong> — Article summaries under{" "}
              <Link
                href="https://creativecommons.org/licenses/by-sa/4.0/"
                target="_blank"
                rel="noopener noreferrer"
              >
                CC BY-SA 4.0
              </Link>
              .
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Wikimedia Commons</strong> — Images under their respective free licenses.
            </Typography>
          </li>
        </ul>
      </Section>

      <Section title="11. Third-Party Terms">
        <Typography>
          Your use of data displayed through OpenMapX may be subject to the terms and conditions of
          the respective third-party data providers listed above. By using features powered by these
          providers, you also agree to comply with their terms of use where applicable.
        </Typography>
      </Section>

      <Section title="12. Indemnification">
        <Typography>
          You agree to indemnify and hold harmless the operator from any claims, losses, damages,
          liabilities, and expenses (including reasonable legal fees) arising out of your violation
          of these Terms or your misuse of the service.
        </Typography>
      </Section>

      <Section title="13. Severability">
        <Typography>
          If any provision of these Terms is found to be invalid or unenforceable, the remaining
          provisions shall continue in full force and effect. The invalid provision shall be
          replaced by a valid provision that most closely reflects the original intent.
        </Typography>
      </Section>

      <Section title="14. Governing Law and Jurisdiction">
        <Typography>
          These Terms are governed by the laws of the Federal Republic of Germany, excluding the UN
          Convention on Contracts for the International Sale of Goods (CISG). If you are a consumer
          within the EU, you also retain the protection of mandatory provisions of the law of your
          country of residence. The exclusive jurisdiction for all disputes arising from or in
          connection with these Terms shall be {jurisdictionCity}, Germany, unless mandatory
          consumer protection laws provide otherwise.
        </Typography>
      </Section>

      <Section title="15. Changes to These Terms">
        <Typography>
          We reserve the right to update these Terms at any time. The current version is always
          available at <Link href="/terms">/terms</Link>. Continued use of the service after changes
          constitutes acceptance of the revised Terms.
        </Typography>
      </Section>

      <Section title="16. Contact">
        <Typography>
          If you have questions about these Terms, please contact us at {email}.
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
