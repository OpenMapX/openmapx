import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import type { Disclosure } from "@openmapx/core/server";
import { legalConfig, sectionSlug } from "@openmapx/core/server";
import { TransitFeedAttribution } from "@/components/legal/TransitFeedAttribution";
import { generateAttributionSectionsFromManifests } from "../generateLegalSections";
import { termsIds, termsTitles } from "./sections";

// Headings and anchors come from the shared section source, so the sidebar
// in `page.tsx` and this content can never disagree.
const T = termsTitles("en");
const IDS = termsIds("en");

export default function TermsContent({
  capabilities: _capabilities = {},
  integrations = [],
  disclosures = [],
}: {
  capabilities?: Record<string, boolean>;
  integrations?: import("@openmapx/integration-framework").LoadedIntegrationMeta[];
  disclosures?: Disclosure[];
}) {
  const { name, street, postalCode, city, country, email } = legalConfig;

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 1 }}>
        Terms of Service
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mb: 4,
        }}
      >
        Last updated: August 10, 2026
      </Typography>
      <Section title={T.scope}>
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
      <Section title={T.service}>
        <Typography>
          OpenMapX is a free, open-data mapping service that provides map viewing, address search,
          route planning (including isochrones and elevation profiles), public transit information,
          street-level imagery, place photos and knowledge data, live traffic overlays, air quality
          data, weather alerts, wildfire and earthquake monitoring, natural event tracking,
          satellite imagery, hiking and outdoor trail information, parking availability, EV charging
          station locations, fuel prices, shared mobility data (bike-sharing, e-scooters,
          car-sharing), and general place information. The service aggregates data from multiple
          open-data sources and third-party APIs as listed in Section 12 below.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Where the operator has enabled it, the service additionally offers an optional, manually
          operated editor for submitting corrections and public notes to OpenStreetMap under your
          own account. See Section&nbsp;11.
        </Typography>
      </Section>
      <Section title={T.availability}>
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
      <Section title={T.accounts}>
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
      <Section title={T.acceptableUse}>
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
              Extract, copy, or misuse API keys, credentials, or other authentication secrets
              embedded in the service infrastructure.
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
          <li>
            <Typography>
              Submit fake, misleading, paid, or incentivized reviews; post reviews on behalf of a
              business you own or work for (undisclosed astroturfing); or review a place you have no
              first-hand experience with.
            </Typography>
          </li>
          <li>
            <Typography>
              Use the review feature to defame, threaten, harass, dox, or out-identify other people
              or businesses, or to post content that is unlawful, hateful, sexually explicit, or
              otherwise inappropriate.
            </Typography>
          </li>
          <li>
            <Typography>
              Attempt to forge Mangrove signatures, impersonate another reviewer, or publish content
              under a keypair you are not authorized to use.
            </Typography>
          </li>
          <li>
            <Typography>
              Submit OpenStreetMap contributions that are false, unverifiable or vandalising; copy
              into OpenStreetMap any content from another map, directory or protected database
              without a compatible right or licence; or use the contribution feature for bulk,
              scripted or otherwise automated editing (see Section&nbsp;11).
            </Typography>
          </li>
        </ul>
      </Section>
      <Section title={T.warranty}>
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
            <Typography>Weather alerts and severe weather warnings</Typography>
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
          <strong>Geographic coverage and data completeness.</strong> OpenMapX aggregates data from
          regional and national data providers. Many features, including but not limited to weather
          alerts, public transit information, traffic data, air quality measurements, and fuel
          prices, are only available in certain countries or regions. Coverage depends entirely on
          the availability of open-data sources in a given area and may change without notice. The
          absence of data for a particular location does not indicate that no relevant information
          exists; it means that no suitable open-data source is currently integrated for that area.
          We make no representation that any feature is available worldwide or that data displayed
          is complete for any given region.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          <strong>
            Do not rely on OpenMapX for safety-critical decisions, emergency navigation, disaster
            response, or situations where inaccurate information could lead to harm. In particular,
            weather alerts, wildfire detections, earthquake data, and other natural disaster
            information may be delayed, incomplete, or unavailable in your region and must not be
            used as a substitute for official emergency alerts from your national weather service or
            civil protection authority.
          </strong>
        </Typography>
        <Typography sx={{ mt: 1 }}>
          OpenMapX is a free service that relies entirely on third-party data sources beyond the
          operator&apos;s control. The operator does not guarantee uninterrupted availability,
          error-free operation, or the accuracy of any data displayed. Your statutory rights remain
          unaffected.
        </Typography>
      </Section>
      {disclosures.some((d) => d.type === "ai-search" && d.aiActive) && (
        <Section title={T.aiSearch} id={IDS.aiSearch}>
          <Typography>
            OpenMapX uses artificial-intelligence models to interpret natural-language search
            queries — for example, turning &quot;quiet café with outdoor seating near the park&quot;
            into a structured search. Depending on this deployment&apos;s configuration,
            interpretation may run on a locally hosted model and/or a third-party cloud model. AI
            interpretation is probabilistic: it can misunderstand your query, omit relevant results,
            surface irrelevant ones, or otherwise produce inaccurate or incomplete output. Results
            are suggestions, not authoritative answers — do not rely on them for safety-, legal-,
            financial-, or health-critical decisions, and independently verify anything important.
            The underlying map data, routing, and place information remain subject to the
            &quot;Accuracy and No Warranty&quot; section above.
          </Typography>
        </Section>
      )}
      <Section title={T.liability}>
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
      <Section title={T.intellectualProperty}>
        <Typography>
          The OpenMapX application code, design, and branding are the property of the operator. The
          map data, transit information, and other content displayed through the service is sourced
          from third parties and is subject to their respective licenses (see Section 12 below).
        </Typography>
        <Typography sx={{ mt: 1 }}>
          You may not use the OpenMapX name, logo, or branding without prior written consent.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          <strong>Reviews you submit remain your own work.</strong> We do not claim ownership of
          review content you create. The licensing of reviews published through the Mangrove network
          is governed by Section&nbsp;10 below.
        </Typography>
      </Section>
      <Section title={T.privacy}>
        <Typography>
          Your use of OpenMapX is also governed by our <Link href="/privacy">Privacy Policy</Link>,
          which describes how we collect, use, and protect your data.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          If you use the OpenStreetMap contribution feature, note that what you publish — including
          your OpenStreetMap user name — becomes public and permanent in OpenStreetMap&apos;s own
          database. The Privacy Policy&apos;s &ldquo;OpenStreetMap Contributions&rdquo; section
          explains exactly what is sent and on what legal basis.
        </Typography>
      </Section>
      <Section title={T.reviews}>
        <Typography>
          OpenMapX integrates the{" "}
          <Link href="https://mangrove.reviews/" target="_blank" rel="noopener noreferrer">
            Mangrove Open Reviews Standard
          </Link>
          . Reviews you submit through OpenMapX are signed in your browser and published to the
          Mangrove network. The following terms apply specifically to review content you create.
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Ownership and license.</strong> You retain all rights in the review content
              you submit (text, rating, uploaded images, experience tags). By publishing a review,
              you license the review content to Mangrove.reviews and to the general public under{" "}
              <Link
                href="https://creativecommons.org/licenses/by/4.0/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Creative Commons Attribution 4.0 International (CC&nbsp;BY&nbsp;4.0)
              </Link>{" "}
              or, where you explicitly select a different Mangrove-compatible license at submission
              time, that license. This grant is worldwide, royalty-free, perpetual, and irrevocable,
              to the extent necessary for aggregators to redistribute and display the review as
              intended by the Mangrove standard.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Warranties you give.</strong> By submitting a review you warrant that: (i) the
              review reflects your genuine, first-hand experience of the subject; (ii) you are not
              being paid or otherwise incentivized by the subject to post a positive or negative
              review without disclosing it in the affiliation field; (iii) any photos you upload are
              your own work, or you hold all rights necessary to publish them under the license
              above, and no third party&apos;s likeness, copyright, trademark, or privacy rights are
              violated; (iv) the review is lawful and contains no defamation, threats, hate speech,
              or protected personal data about identifiable third parties.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Publication is decentralized and partly irreversible.</strong> Once a review
              is signed and submitted, it is propagated through the Mangrove aggregator network and
              may be mirrored by third parties. We can hide a review from the OpenMapX display, and
              we will forward any retraction you sign to <code>api.mangrove.reviews</code>, but we
              cannot guarantee removal from external mirrors, caches, or archives. You accept this
              limitation as a fundamental characteristic of the Mangrove system before submitting.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Moderation.</strong> We may hide, down-rank, or refuse to display any review
              that, in our reasonable judgment, violates these Terms or applicable law. Hiding a
              review on OpenMapX does not automatically retract it from the Mangrove network.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Reporting abuse.</strong> You can flag an abusive review through the in-app
              report action, or contact us at the email address in Section&nbsp;1. Abusive behaviour
              may also lead to account suspension under Section&nbsp;4.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Third-party reviews.</strong> Reviews you view in OpenMapX but did not author
              are third-party user content. The operator does not endorse and is not responsible for
              statements made by other reviewers.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Signing key responsibility.</strong> You are responsible for safeguarding your
              review passphrase and any registered passkeys. Anyone who holds these can sign reviews
              in your name. If you opt in to the unencrypted keypair mode, you additionally accept
              that the operator technically has access to your signing key. Lost passphrases and
              passkeys cannot be recovered; you may regenerate a new keypair, but existing reviews
              will remain linked to the old public key.
            </Typography>
          </li>
        </ul>
      </Section>
      <Section title={T.osmContributions}>
        <Typography>
          If the operator has enabled contributions, OpenMapX lets you correct a limited set of
          facts on an existing{" "}
          <Link href="https://www.openstreetmap.org/" target="_blank" rel="noopener noreferrer">
            OpenStreetMap
          </Link>{" "}
          feature, or submit a public OpenStreetMap note. Using this feature is entirely optional.
          The following terms apply when you do.
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>You act through your own account.</strong> Contributions are published with
              your own linked OpenStreetMap account, not the operator&apos;s. You are responsible
              for the content you submit — the changed values, your changeset comment, your stated
              source and any note text — and for ensuring it is factual, lawful and verifiable.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Do not copy from sources you may not use.</strong> You must not take content
              from another map, a commercial directory, a search engine result, or any database
              protected by copyright, database rights or contract, unless you hold a right or
              licence that permits contributing it to OpenStreetMap. Checking a competing map to
              &ldquo;confirm&rdquo; a fact is not permitted.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>OpenStreetMap&apos;s own rules apply.</strong> You must accept and comply with
              the{" "}
              <Link
                href="https://osmfoundation.org/wiki/Licence/Contributor_Terms"
                target="_blank"
                rel="noopener noreferrer"
              >
                OpenStreetMap Contributor Terms
              </Link>{" "}
              and the community&apos;s{" "}
              <Link
                href="https://wiki.openstreetmap.org/wiki/Good_practice"
                target="_blank"
                rel="noopener noreferrer"
              >
                good practice
              </Link>{" "}
              and{" "}
              <Link
                href="https://wiki.openstreetmap.org/wiki/Verifiable"
                target="_blank"
                rel="noopener noreferrer"
              >
                verifiability
              </Link>{" "}
              guidelines. Your contributions and your contribution history are public.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>No personal, confidential or unlawful content.</strong> Changeset comments and
              notes are published and permanently retained by OpenStreetMap. Do not include personal
              data about yourself or others, confidential information, complaints about individuals,
              or any unlawful, defamatory or infringing content. Notes are for map-data problems,
              not for feedback about OpenMapX.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>OpenStreetMap, not OpenMapX, is the authority.</strong> The public database
              and its edit history are operated by the OpenStreetMap Foundation under its own terms.
              The operator cannot promise that a contribution will be accepted, kept, visible,
              propagated to other services, reverted or deleted, and cannot remove a contribution
              from OpenStreetMap on your behalf. Other mappers may change or revert your edit.
              Requests concerning published contributions must be directed to the OpenStreetMap
              Foundation.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Propagation is not immediate.</strong> OpenMapX and other data consumers
              rebuild their copies of OpenStreetMap data on their own schedules. A published
              correction may not appear in OpenMapX for some time. That is normal and is not a
              defect.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>The operator may limit or disable this feature.</strong> To protect
              OpenStreetMap and its users, the operator may rate-limit contributions, refuse a
              submission, or disable the contribution or direct-editing functionality entirely, at
              any time and without notice. Misuse may also lead to account suspension under
              Section&nbsp;4.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Automated editing is not permitted.</strong> This feature is a manual editor
              for individual, human-initiated corrections. You must not use it, or attempt to
              automate it, for bulk, scripted or mechanical edits.
            </Typography>
          </li>
        </ul>
      </Section>
      <Section title={T.dataSources} id={IDS.dataSources}>
        <Typography>
          OpenMapX is built on open data. We gratefully acknowledge the following data sources and
          their respective licenses. Where a license applies, clicking the license name will take
          you to the full license text.
        </Typography>

        {generateAttributionSectionsFromManifests(integrations, "en").map((section) => (
          <AttributionTable key={section.heading} heading={section.heading} rows={section.rows} />
        ))}

        <TransitFeedAttribution
          feeds={[]}
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
      <Section title={T.thirdParty}>
        <Typography>
          Your use of data displayed through OpenMapX may be subject to the terms and conditions of
          the respective third-party data providers listed above. By using features powered by these
          providers, you also agree to comply with their terms of use where applicable. In
          particular, data sourced from OpenStreetMap is available under the ODbL, which requires
          attribution and share-alike for derivative databases.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          These licences describe what you may do with data OpenMapX <em>displays</em> to you. They
          are not permission to move data in the other direction. Nothing above allows you to copy
          facts from one provider into another provider&apos;s database — in particular, do not copy
          any third-party content into OpenStreetMap through the contribution feature unless you
          hold a right or licence that permits it (see Sections&nbsp;5 and&nbsp;11).
        </Typography>
        {integrations.some((i) => i.id === "photos-flickr" && i.enabled) && (
          <Typography sx={{ mt: 1 }}>
            This product uses the Flickr API but is not endorsed or certified by SmugMug, Inc.
          </Typography>
        )}
      </Section>
      <Section title={T.severability}>
        <Typography>
          If any provision of these Terms is found to be invalid or unenforceable, the remaining
          provisions shall continue in full force and effect. The invalid provision shall be
          replaced by a valid provision that most closely reflects the original intent.
        </Typography>
      </Section>
      <Section title={T.governingLaw}>
        <Typography>
          These Terms are governed by the laws of the Federal Republic of Germany, excluding the UN
          Convention on Contracts for the International Sale of Goods (CISG). If you are a consumer
          within the EU, you also retain the protection of mandatory provisions of the law of your
          country of residence. Venue is determined by the applicable statutory rules; in
          particular, as a consumer you may bring proceedings at your place of residence and may
          only be sued there.
        </Typography>
      </Section>
      <Section title={T.changes}>
        <Typography>
          We reserve the right to update these Terms at any time. The current version is always
          available at <Link href="/terms">/terms</Link>. We will notify registered users of
          material changes by email at least 30 days before they take effect. If you do not agree
          with the changes, you may stop using the service and delete your account before the
          effective date. Continued use of the service after the notified effective date indicates
          your agreement with the revised Terms.
        </Typography>
      </Section>
      <Section title={T.language}>
        <Typography>
          These Terms are available in German and English. In case of discrepancies between the two
          versions, the German version shall prevail.
        </Typography>
      </Section>
      <Section title={T.contact}>
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
  notes?: string;
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
                <TableCell>
                  {row.desc}
                  {row.notes && (
                    <Typography
                      variant="caption"
                      component="p"
                      sx={{ color: "text.secondary", mt: 0.5 }}
                    >
                      {row.notes}
                    </Typography>
                  )}
                </TableCell>
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
