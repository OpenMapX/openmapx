import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { legalConfig, sectionSlug } from "@openmapx/core/legal";

export default function ImprintContentDe() {
  const { name, street, postalCode, city, country, email, phone } = legalConfig;

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 3 }}>
        Impressum
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mb: 4,
        }}
      >
        Angaben gem&auml;&szlig; &sect; 5 Digitale-Dienste-Gesetz (DDG).
      </Typography>
      <Section title="Anbieter">
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
      <Section title="Kontakt">
        <Typography>
          E-Mail: <Link href={`mailto:${email}`}>{email}</Link>
          {phone && (
            <>
              <br />
              Telefon: {phone}
            </>
          )}
        </Typography>
      </Section>
      <Section title="Verantwortlich f&uuml;r den Inhalt">
        <Typography>
          Verantwortlich f&uuml;r den Inhalt gem&auml;&szlig; &sect; 18 Abs. 2 Medienstaatsvertrag
          (MStV):
        </Typography>
        <Typography sx={{ mt: 1 }}>
          {name}
          <br />
          {street}
          <br />
          {postalCode} {city}
        </Typography>
      </Section>
      <Section title="Verbraucherstreitbeilegung">
        <Typography>
          Als Unternehmen mit weniger als 11 Besch&auml;ftigten sind wir von den
          Informationspflichten nach &sect;&nbsp;36 VSBG befreit. Wir sind gleichwohl weder
          verpflichtet noch bereit, an Streitbeilegungsverfahren vor einer
          Verbraucherschlichtungsstelle teilzunehmen.
        </Typography>
      </Section>
      <Section title="Haftung f&uuml;r Inhalte">
        <Typography>
          Als Diensteanbieter sind wir gem&auml;&szlig; &sect; 7 Abs. 1 DDG f&uuml;r eigene Inhalte
          auf diesen Seiten nach den allgemeinen Gesetzen verantwortlich. Nach &sect;&sect; 8 bis 10
          DDG sind wir als Diensteanbieter jedoch nicht verpflichtet, &uuml;bermittelte oder
          gespeicherte fremde Informationen zu &uuml;berwachen oder nach Umst&auml;nden zu forschen,
          die auf eine rechtswidrige T&auml;tigkeit hinweisen.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Verpflichtungen zur Entfernung oder Sperrung der Nutzung von Informationen nach den
          allgemeinen Gesetzen bleiben hiervon unber&uuml;hrt. Eine diesbez&uuml;gliche Haftung ist
          jedoch erst ab dem Zeitpunkt der Kenntnis einer konkreten Rechtsverletzung m&ouml;glich.
          Bei Bekanntwerden von entsprechenden Rechtsverletzungen werden wir diese Inhalte umgehend
          entfernen.
        </Typography>
      </Section>
      <Section title="Haftung f&uuml;r Links">
        <Typography>
          Unser Angebot enth&auml;lt Links zu externen Websites Dritter, auf deren Inhalte wir
          keinen Einfluss haben. Deshalb k&ouml;nnen wir f&uuml;r diese fremden Inhalte auch keine
          Gew&auml;hr &uuml;bernehmen. F&uuml;r die Inhalte der verlinkten Seiten ist stets der
          jeweilige Anbieter oder Betreiber der Seiten verantwortlich. Die verlinkten Seiten wurden
          zum Zeitpunkt der Verlinkung auf m&ouml;gliche Rechtsverst&ouml;&szlig;e
          &uuml;berpr&uuml;ft. Rechtswidrige Inhalte waren zum Zeitpunkt der Verlinkung nicht
          erkennbar.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Eine permanente inhaltliche Kontrolle der verlinkten Seiten ist jedoch ohne konkrete
          Anhaltspunkte einer Rechtsverletzung nicht zumutbar. Bei Bekanntwerden von
          Rechtsverletzungen werden wir derartige Links umgehend entfernen.
        </Typography>
      </Section>
      <Section title="Urheberrecht">
        <Typography>
          Die durch die Seitenbetreiber erstellten Inhalte und Werke auf diesen Seiten unterliegen
          dem deutschen Urheberrecht. Die Vervielf&auml;ltigung, Bearbeitung, Verbreitung und jede
          Art der Verwertung au&szlig;erhalb der Grenzen des Urheberrechtes bed&uuml;rfen der
          schriftlichen Zustimmung des jeweiligen Autors bzw. Erstellers. Downloads und Kopien
          dieser Seite sind nur f&uuml;r den privaten, nicht kommerziellen Gebrauch gestattet.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Soweit die Inhalte auf dieser Seite nicht vom Betreiber erstellt wurden, werden die
          Urheberrechte Dritter beachtet. Insbesondere werden Inhalte Dritter als solche
          gekennzeichnet. Sollten Sie trotzdem auf eine Urheberrechtsverletzung aufmerksam werden,
          bitten wir um einen entsprechenden Hinweis. Bei Bekanntwerden von Rechtsverletzungen
          werden wir derartige Inhalte umgehend entfernen.
        </Typography>
      </Section>
      <Section title="Kartendaten und Drittanbieter-Zuordnungen">
        <Typography>
          OpenMapX nutzt offene Daten aus verschiedenen Quellen. Detaillierte Quellenangaben
          f&uuml;r alle Datenanbieter finden Sie in den{" "}
          <Link href="/terms#data-sources">Nutzungsbedingungen</Link>.
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
