import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { legalConfig, sectionSlug } from "@openmapx/core/server";

export default function ImprintContent() {
  const { name, street, postalCode, city, country, email, phone } = legalConfig;

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 3 }}>
        Legal Notice (Impressum)
      </Typography>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
        Information pursuant to Section 5 of the German Digitale-Dienste-Gesetz (DDG).
      </Typography>

      <Section title="Provider">
        <Typography>
          {name}
          <br />
          {street}
          <br />
          {postalCode} {city}
          <br />
          {country}
        </Typography>
      </Section>

      <Section title="Contact">
        <Typography>
          Email: <Link href={`mailto:${email}`}>{email}</Link>
          {phone && (
            <>
              <br />
              Phone: {phone}
            </>
          )}
        </Typography>
      </Section>

      <Section title="Responsible for Content">
        <Typography>
          Responsible for content pursuant to Section 18 (2) of the Medienstaatsvertrag (MStV):
        </Typography>
        <Typography sx={{ mt: 1 }}>
          {name}
          <br />
          {street}
          <br />
          {postalCode} {city}
        </Typography>
      </Section>

      <Section title="Consumer Dispute Resolution">
        <Typography>
          As a business with fewer than 11 employees, we are exempt from the information
          requirements of &sect;&nbsp;36 VSBG. We are nevertheless neither obligated nor willing to
          participate in dispute resolution proceedings before a consumer arbitration board.
        </Typography>
      </Section>

      <Section title="Liability for Content">
        <Typography>
          As a service provider, we are responsible for our own content on these pages in accordance
          with general legislation pursuant to Section 7 (1) DDG. However, pursuant to Sections 8 to
          10 DDG, we as a service provider are not obligated to monitor transmitted or stored
          third-party information or to investigate circumstances that indicate illegal activity.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Obligations to remove or block the use of information in accordance with general
          legislation remain unaffected. However, liability in this regard is only possible from the
          point in time at which a concrete infringement of the law becomes known. If we become
          aware of such infringements, we will remove this content immediately.
        </Typography>
      </Section>

      <Section title="Liability for Links">
        <Typography>
          Our website contains links to external third-party websites over whose content we have no
          influence. Therefore, we cannot accept any liability for this third-party content. The
          respective provider or operator of the linked pages is always responsible for the content
          of the linked pages. The linked pages were checked for possible legal violations at the
          time of linking. Illegal content was not recognizable at the time of linking.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          However, permanent monitoring of the content of the linked pages is unreasonable without
          concrete evidence of a legal violation. If we become aware of any legal violations, we
          will remove such links immediately.
        </Typography>
      </Section>

      <Section title="Copyright">
        <Typography>
          The content and works created by the site operators on these pages are subject to German
          copyright law. Duplication, processing, distribution, and any kind of use beyond the
          limits of copyright law require the written consent of the respective author or creator.
          Downloads and copies of this site are only permitted for private, non-commercial use.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Insofar as the content on this site was not created by the operator, the copyrights of
          third parties are respected. In particular, third-party content is identified as such.
          Should you nevertheless become aware of a copyright infringement, please inform us
          accordingly. If we become aware of any infringements, we will remove such content
          immediately.
        </Typography>
      </Section>

      <Section title="Map Data and Third-Party Attributions">
        <Typography>
          OpenMapX uses open data from various sources. Detailed attribution information for all
          data providers can be found in the{" "}
          <Link href="/terms#data-sources">Terms of Service</Link>.
        </Typography>
      </Section>
    </Box>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box id={sectionSlug(title)} sx={{ mb: 3, scrollMarginTop: 16 }}>
      <Typography variant="h6" component="h2" sx={{ fontWeight: 600, mb: 1 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}
