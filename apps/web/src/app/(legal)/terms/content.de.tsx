import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { legalConfig } from "@/lib/legalConfig";
import { sectionSlug } from "@/lib/sectionSlug";

export default function TermsContentDe() {
  const { name, street, postalCode, city, country, email, jurisdictionCity } = legalConfig;

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 1 }}>
        Nutzungsbedingungen
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
        Zuletzt aktualisiert: M&auml;rz 2026
      </Typography>

      <Section title="1. Geltungsbereich und Anbieter">
        <Typography>
          Diese Nutzungsbedingungen (&quot;Bedingungen&quot;) regeln Ihre Nutzung von OpenMapX,
          einer Open-Data-Kartenplattform, betrieben von:
        </Typography>
        <Typography sx={{ mt: 1 }}>
          {name}
          <br />
          {street}
          <br />
          {postalCode} {city}, {country}
          <br />
          E-Mail: {email}
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Durch den Zugriff auf oder die Nutzung von OpenMapX stimmen Sie diesen Bedingungen zu.
          Wenn Sie nicht einverstanden sind, nutzen Sie den Dienst bitte nicht.
        </Typography>
      </Section>

      <Section title="2. Beschreibung des Dienstes">
        <Typography>
          OpenMapX ist ein kostenloser Open-Data-Kartendienst, der Kartenansicht, Adresssuche,
          Routenplanung, Nahverkehrsinformationen, Stra&szlig;enansicht, Luftqualit&auml;tsdaten,
          E-Ladestation-Standorte, Kraftstoffpreise, geteilte Mobilit&auml;tsdaten und
          Ortsinformationen bietet. Der Dienst aggregiert Daten aus mehreren offenen Datenquellen
          und Drittanbieter-APIs.
        </Typography>
      </Section>

      <Section title="3. Verf&uuml;gbarkeit und &Auml;nderungen">
        <Typography>
          OpenMapX wird auf einer &quot;Ist-Zustand&quot;- und &quot;Wie-verf&uuml;gbar&quot;-Basis
          bereitgestellt. Wir sind bestrebt, den Dienst am Laufen zu halten, garantieren jedoch
          keine ununterbrochene oder fehlerfreie Verf&uuml;gbarkeit. Wir behalten uns das Recht vor,
          Teile des Dienstes jederzeit ohne vorherige Ank&uuml;ndigung zu &auml;ndern, auszusetzen
          oder einzustellen.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Da wir von zahlreichen Drittanbieter-Datenquellen abh&auml;ngig sind, k&ouml;nnen einzelne
          Funktionen nicht verf&uuml;gbar sein, wenn vorgelagerte Anbieter ihre APIs, Bedingungen
          oder Verf&uuml;gbarkeit &auml;ndern.
        </Typography>
      </Section>

      <Section title="4. Benutzerkonten">
        <Typography>
          Die Kontoerstellung ist optional. Sie k&ouml;nnen die meisten Funktionen von OpenMapX ohne
          Konto nutzen. Wenn Sie ein Konto erstellen:
        </Typography>
        <ul>
          <li>
            <Typography>
              Sie sind f&uuml;r die Vertraulichkeit Ihrer Anmeldedaten verantwortlich.
            </Typography>
          </li>
          <li>
            <Typography>
              Sie verpflichten sich, korrekte Angaben zu machen und diese aktuell zu halten.
            </Typography>
          </li>
          <li>
            <Typography>
              Sie sind f&uuml;r alle Aktivit&auml;ten unter Ihrem Konto verantwortlich.
            </Typography>
          </li>
          <li>
            <Typography>
              Sie k&ouml;nnen Ihr Konto jederzeit &uuml;ber die Kontoeinstellungen l&ouml;schen.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Wir behalten uns das Recht vor, Konten, die gegen diese Bedingungen versto&szlig;en, zu
          sperren oder zu l&ouml;schen.
        </Typography>
      </Section>

      <Section title="5. Zul&auml;ssige Nutzung">
        <Typography>Sie verpflichten sich, Folgendes zu unterlassen:</Typography>
        <ul>
          <li>
            <Typography>
              Den Dienst f&uuml;r rechtswidrige Zwecke oder unter Versto&szlig; gegen geltendes
              Recht zu nutzen.
            </Typography>
          </li>
          <li>
            <Typography>
              Systematisches Scraping, Sammeln oder Extrahieren von Daten aus dem Dienst &uuml;ber
              die normale pers&ouml;nliche Nutzung hinaus.
            </Typography>
          </li>
          <li>
            <Typography>
              Den Versuch, den Dienst oder seine Infrastruktur zu st&ouml;ren, zu
              beeintr&auml;chtigen oder unbefugten Zugang zu erlangen.
            </Typography>
          </li>
          <li>
            <Typography>
              Die Verwendung automatisierter Werkzeuge (Bots, Crawler), um den Dienst mit einer Rate
              zu nutzen, die das Erlebnis f&uuml;r andere Nutzer beeintr&auml;chtigt.
            </Typography>
          </li>
          <li>
            <Typography>
              Reverse Engineering, Dekompilierung oder den Versuch, den Quellcode des Dienstes
              &uuml;ber das hinaus zu extrahieren, was die Open-Source-Lizenz erlaubt.
            </Typography>
          </li>
          <li>
            <Typography>
              Sich als eine andere Person oder Organisation auszugeben oder Ihre Zugeh&ouml;rigkeit
              falsch darzustellen.
            </Typography>
          </li>
        </ul>
      </Section>

      <Section title="6. Genauigkeit und Gew&auml;hrleistungsausschluss">
        <Typography>
          OpenMapX aggregiert Daten aus Drittanbieterquellen. Obwohl wir um Genauigkeit bem&uuml;ht
          sind, &uuml;bernehmen wir keine Gew&auml;hrleistung oder Zusicherung hinsichtlich der
          Vollst&auml;ndigkeit, Genauigkeit, Zuverl&auml;ssigkeit oder Aktualit&auml;t der
          angezeigten Daten, einschlie&szlig;lich, aber nicht beschr&auml;nkt auf:
        </Typography>
        <ul>
          <li>
            <Typography>Kartendaten, Ortsnamen und geografische Koordinaten</Typography>
          </li>
          <li>
            <Typography>Routenberechnungen, Reisezeiten und Entfernungen</Typography>
          </li>
          <li>
            <Typography>Nahverkehrsfahrpl&auml;ne und Echtzeitank&uuml;nfte</Typography>
          </li>
          <li>
            <Typography>Kraftstoffpreise, E-Ladestation-Verf&uuml;gbarkeit und Preise</Typography>
          </li>
          <li>
            <Typography>Luftqualit&auml;tsmessungen</Typography>
          </li>
          <li>
            <Typography>Verf&uuml;gbarkeit geteilter Mobilit&auml;tsfahrzeuge</Typography>
          </li>
          <li>
            <Typography>&Ouml;ffnungszeiten, Kontaktinformationen und Ortsdetails</Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          <strong>
            Verlassen Sie sich nicht auf OpenMapX f&uuml;r sicherheitskritische Entscheidungen,
            Notfallnavigation oder Situationen, in denen ungenaue Informationen zu Sch&auml;den
            f&uuml;hren k&ouml;nnten.
          </strong>
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Soweit nach geltendem Recht zul&auml;ssig, wird der Dienst ohne jegliche
          Gew&auml;hrleistung gleich welcher Art bereitgestellt, sei es ausdr&uuml;cklich,
          stillschweigend oder gesetzlich, einschlie&szlig;lich, aber nicht beschr&auml;nkt auf
          stillschweigende Gew&auml;hrleistungen der Marktg&auml;ngigkeit, Eignung f&uuml;r einen
          bestimmten Zweck und Nichtverletzung von Rechten Dritter.
        </Typography>
      </Section>

      <Section title="7. Haftungsbeschr&auml;nkung">
        <Typography>
          Soweit nach geltendem Recht zul&auml;ssig, haftet der Betreiber nicht f&uuml;r mittelbare,
          beil&auml;ufige, besondere, Folge- oder Strafsch&auml;den oder entgangene Gewinne oder
          Einnahmen, die direkt oder indirekt entstehen, oder f&uuml;r Datenverlust,
          Nutzungsausfall, Gesch&auml;ftswertminderung oder andere immaterielle Verluste, die sich
          ergeben aus:
        </Typography>
        <ul>
          <li>
            <Typography>Ihrer Nutzung oder Unf&auml;higkeit zur Nutzung des Dienstes.</Typography>
          </li>
          <li>
            <Typography>
              Ungenauigkeiten oder Unvollst&auml;ndigkeit der vom Dienst bereitgestellten Daten.
            </Typography>
          </li>
          <li>
            <Typography>
              Unbefugtem Zugriff auf oder &Auml;nderung Ihrer Daten oder &Uuml;bertragungen.
            </Typography>
          </li>
          <li>
            <Typography>Verhalten oder Inhalten Dritter im Rahmen des Dienstes.</Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Nichts in diesen Bedingungen schlie&szlig;t die Haftung f&uuml;r Vorsatz oder grobe
          Fahrl&auml;ssigkeit aus oder beschr&auml;nkt sie, ebenso wenig wie die Haftung f&uuml;r
          Sch&auml;den aus der Verletzung des Lebens, des K&ouml;rpers oder der Gesundheit oder
          sonstige Haftung, die nach geltendem deutschen Recht nicht ausgeschlossen oder
          beschr&auml;nkt werden kann.
        </Typography>
      </Section>

      <Section title="8. Geistiges Eigentum">
        <Typography>
          Der OpenMapX-Anwendungscode, das Design und die Marke sind Eigentum des Betreibers. Die
          Kartendaten, Nahverkehrsinformationen und sonstigen &uuml;ber den Dienst angezeigten
          Inhalte stammen von Dritten und unterliegen deren jeweiligen Lizenzen (siehe Abschnitt 10
          unten).
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Sie d&uuml;rfen den Namen, das Logo oder die Marke von OpenMapX nicht ohne vorherige
          schriftliche Zustimmung verwenden.
        </Typography>
      </Section>

      <Section title="9. Datenschutz">
        <Typography>
          Ihre Nutzung von OpenMapX unterliegt auch unserer{" "}
          <Link href="/privacy">Datenschutzerkl&auml;rung</Link>, die beschreibt, wie wir Ihre Daten
          erheben, verwenden und sch&uuml;tzen.
        </Typography>
      </Section>

      <Section title="10. Datenquellen und Quellenangaben" id="data-sources">
        <Typography>
          OpenMapX basiert auf offenen Daten. Wir danken den folgenden Datenquellen und ihren
          jeweiligen Lizenzen:
        </Typography>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Kartendaten
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>OpenStreetMap</strong> &mdash; Kartendaten &copy; OpenStreetMap-Mitwirkende,
              verf&uuml;gbar unter der{" "}
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
              <strong>MapTiler</strong> &mdash; Kartenkacheln und Geokodierung von{" "}
              <Link href="https://www.maptiler.com/" target="_blank" rel="noopener noreferrer">
                MapTiler
              </Link>
              .
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Routenplanung
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>OSRM</strong> &mdash; Open Source Routing Machine, basierend auf
              OpenStreetMap-Daten.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Valhalla</strong> &mdash; Open-Source-Routing-Engine von Mapzen /
              Valhalla-Mitwirkenden, gehostet von{" "}
              <Link href="https://fossgis.de/" target="_blank" rel="noopener noreferrer">
                FOSSGIS e.V.
              </Link>
              .
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Stra&szlig;enansicht
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Mapillary</strong> &mdash; Stra&szlig;enfotos &copy;{" "}
              <Link href="https://www.mapillary.com/" target="_blank" rel="noopener noreferrer">
                Mapillary
              </Link>
              -Mitwirkende, verf&uuml;gbar unter CC-BY-SA.
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Verkehr
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>TomTom</strong> &mdash; Verkehrsflussdaten &copy;{" "}
              <Link href="https://www.tomtom.com/" target="_blank" rel="noopener noreferrer">
                TomTom International BV
              </Link>
              .
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          &Ouml;ffentlicher Nahverkehr
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Transitous</strong> &mdash; Offenes multimodales Routing, basierend auf MOTIS.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>TransitLand</strong> &mdash; Nahverkehrsdatenaggregation von{" "}
              <Link href="https://www.transit.land/" target="_blank" rel="noopener noreferrer">
                Interline Technologies
              </Link>
              .
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>transport.rest</strong> &mdash; Deutsche Nahverkehrs-APIs von Jannis R,
              verf&uuml;gbar unter ISC-Lizenz.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>iRail</strong> &mdash; Belgische Bahndaten, Open Source.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>transport.opendata.ch</strong> &mdash; Schweizer &ouml;ffentliche
              Verkehrsdaten.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>TfL</strong> &mdash; Erm&ouml;glicht durch TfL Open Data. Enth&auml;lt
              OS-Daten &copy; Crown Copyright und Datenbankrechte.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>MBTA</strong> &mdash; Daten bereitgestellt von der Massachusetts Bay
              Transportation Authority.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>GTFS-Feeds</strong> &mdash; Verschiedene Verkehrsunternehmen. Siehe den{" "}
              <Link
                href="https://github.com/transitous/transitous"
                target="_blank"
                rel="noopener noreferrer"
              >
                Transitous-Katalog
              </Link>{" "}
              f&uuml;r einzelne Feed-Zuordnungen.
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Luftqualit&auml;t
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>OpenAQ</strong> &mdash; Luftqualit&auml;tsdaten von der{" "}
              <Link href="https://openaq.org/" target="_blank" rel="noopener noreferrer">
                OpenAQ
              </Link>
              -Plattform, bezogen von staatlichen Messnetzen weltweit.
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          E-Ladestationen
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>OpenChargeMap</strong> &mdash; E-Ladedaten von{" "}
              <Link href="https://openchargemap.org/" target="_blank" rel="noopener noreferrer">
                OpenChargeMap
              </Link>
              , verf&uuml;gbar unter CC-BY-SA.
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Kraftstoffpreise
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Tankerkoenig</strong> &mdash; Deutsche Kraftstoffpreisdaten unter CC BY 4.0,
              basierend auf Daten der Markttransparenzstelle f&uuml;r Kraftstoffe (MTS-K).
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Staatliche Open Data</strong> &mdash; Franz&ouml;sische, spanische und
              &ouml;sterreichische Kraftstoffpreise aus offiziellen staatlichen Datenportalen.
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Geteilte Mobilit&auml;t
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Citybikes</strong> &mdash; Globale Bike-Sharing-Daten via{" "}
              <Link href="https://citybik.es/" target="_blank" rel="noopener noreferrer">
                citybik.es
              </Link>
              .
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Deutsche Bahn</strong> &mdash; Geteilte Mobilit&auml;tsdaten via DB Open Data.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Nextbike, Cambio, Donkey Republic, Felyx, Link, GO Sharing</strong> &mdash;
              Fahrzeugverf&uuml;gbarkeitsdaten der jeweiligen Betreiber.
            </Typography>
          </li>
        </ul>

        <Typography variant="subtitle2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
          Ortsinformationen
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Wikidata</strong> &mdash; Strukturierte Daten unter{" "}
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
              <strong>Wikipedia</strong> &mdash; Artikelzusammenfassungen unter{" "}
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
              <strong>Wikimedia Commons</strong> &mdash; Bilder unter ihren jeweiligen freien
              Lizenzen.
            </Typography>
          </li>
        </ul>
      </Section>

      <Section title="11. Drittanbieter-Bedingungen">
        <Typography>
          Ihre Nutzung der &uuml;ber OpenMapX angezeigten Daten kann den Nutzungsbedingungen der
          jeweiligen oben aufgef&uuml;hrten Drittanbieter-Datenquellen unterliegen. Durch die
          Nutzung von Funktionen, die von diesen Anbietern bereitgestellt werden, stimmen Sie auch
          deren Nutzungsbedingungen zu, soweit anwendbar.
        </Typography>
      </Section>

      <Section title="12. Freistellung">
        <Typography>
          Sie erkl&auml;ren sich bereit, den Betreiber von allen Anspr&uuml;chen, Verlusten,
          Sch&auml;den, Verbindlichkeiten und Kosten (einschlie&szlig;lich angemessener
          Anwaltskosten) freizustellen, die aus Ihrem Versto&szlig; gegen diese Bedingungen oder
          Ihrem Missbrauch des Dienstes resultieren.
        </Typography>
      </Section>

      <Section title="13. Salvatorische Klausel">
        <Typography>
          Sollte eine Bestimmung dieser Bedingungen f&uuml;r unwirksam oder undurchsetzbar befunden
          werden, bleiben die &uuml;brigen Bestimmungen in vollem Umfang g&uuml;ltig und wirksam.
          Die unwirksame Bestimmung wird durch eine g&uuml;ltige Bestimmung ersetzt, die der
          urspr&uuml;nglichen Absicht am n&auml;chsten kommt.
        </Typography>
      </Section>

      <Section title="14. Anwendbares Recht und Gerichtsstand">
        <Typography>
          Diese Bedingungen unterliegen dem Recht der Bundesrepublik Deutschland unter Ausschluss
          des UN-Kaufrechts (CISG). Sind Sie Verbraucher innerhalb der EU, genie&szlig;en Sie
          zus&auml;tzlich den Schutz zwingender Bestimmungen des Rechts Ihres Wohnsitzlandes.
          Ausschlie&szlig;licher Gerichtsstand f&uuml;r alle Streitigkeiten aus oder im Zusammenhang
          mit diesen Bedingungen ist {jurisdictionCity}, Deutschland, sofern nicht zwingende
          Verbraucherschutzgesetze etwas anderes vorsehen.
        </Typography>
      </Section>

      <Section title="15. &Auml;nderungen dieser Bedingungen">
        <Typography>
          Wir behalten uns das Recht vor, diese Bedingungen jederzeit zu aktualisieren. Die aktuelle
          Version ist stets unter <Link href="/terms">/terms</Link> verf&uuml;gbar. Die fortgesetzte
          Nutzung des Dienstes nach &Auml;nderungen gilt als Annahme der ge&auml;nderten
          Bedingungen.
        </Typography>
      </Section>

      <Section title="16. Kontakt">
        <Typography>
          Wenn Sie Fragen zu diesen Bedingungen haben, kontaktieren Sie uns bitte unter {email}.
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
