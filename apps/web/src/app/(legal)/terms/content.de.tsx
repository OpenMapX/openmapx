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

export default function TermsContentDe({
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
          E-Mail: <Link href={`mailto:${email}`}>{email}</Link>
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Durch den Zugriff auf oder die Nutzung von OpenMapX stimmen Sie diesen Bedingungen zu.
          Wenn Sie nicht einverstanden sind, nutzen Sie den Dienst bitte nicht.
        </Typography>
      </Section>

      <Section title="2. Beschreibung des Dienstes">
        <Typography>
          OpenMapX ist ein kostenloser Open-Data-Kartendienst, der Kartenansicht, Adresssuche,
          Routenplanung (einschlie&szlig;lich Isochronen und H&ouml;henprofilen),
          Nahverkehrsinformationen, Stra&szlig;enansicht, Ortsfotos und Anreicherungsdaten,
          Live-Verkehrs-Overlays, Luftqualit&auml;tsdaten, Waldbrand- und Erdbeben&uuml;berwachung,
          Wander- und Outdoor-Informationen, Parkplatzverf&uuml;gbarkeit, E-Ladestation-Standorte,
          Kraftstoffpreise, geteilte Mobilit&auml;tsdaten (Bike-Sharing, E-Scooter, Carsharing) und
          allgemeine Ortsinformationen bietet. Der Dienst aggregiert Daten aus mehreren offenen
          Datenquellen und Drittanbieter-APIs wie in Abschnitt&nbsp;10 aufgef&uuml;hrt.
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
          Sie m&uuml;ssen mindestens 16&nbsp;Jahre alt sein, um ein Konto zu erstellen. Mit der
          Erstellung eines Kontos best&auml;tigen Sie, dass Sie diese Altersanforderung
          erf&uuml;llen.
        </Typography>
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
              Reverse Engineering, Dekompilierung oder den Versuch, den Quellcode des Dienstes zu
              extrahieren.
            </Typography>
          </li>
          <li>
            <Typography>
              Sich als eine andere Person oder Organisation auszugeben oder Ihre Zugeh&ouml;rigkeit
              falsch darzustellen.
            </Typography>
          </li>
          <li>
            <Typography>
              Rate-Limits, Zugriffskontrollen oder andere Sicherheitsma&szlig;nahmen des Dienstes
              oder seiner vorgelagerten Datenanbieter zu umgehen.
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
            <Typography>Isochrone Gebiete und H&ouml;henprofile</Typography>
          </li>
          <li>
            <Typography>
              Nahverkehrsfahrpl&auml;ne, Echtzeitank&uuml;nfte und Betriebsmeldungen
            </Typography>
          </li>
          <li>
            <Typography>Kraftstoffpreise, E-Ladestation-Verf&uuml;gbarkeit und Preise</Typography>
          </li>
          <li>
            <Typography>Luftqualit&auml;tsmessungen und Umweltindizes</Typography>
          </li>
          <li>
            <Typography>
              Waldbranderkennungen, Erdbebendaten und andere Naturkatastrophen-Informationen
            </Typography>
          </li>
          <li>
            <Typography>
              Wanderweg-Informationen, Schwierigkeitsgrade und H&uuml;ttenverf&uuml;gbarkeit
            </Typography>
          </li>
          <li>
            <Typography>Parkplatzauslastung und Kapazit&auml;tsdaten</Typography>
          </li>
          <li>
            <Typography>
              Verf&uuml;gbarkeit und Standorte von Fahrzeugen geteilter Mobilit&auml;t
            </Typography>
          </li>
          <li>
            <Typography>Stra&szlig;enansicht und Ortsfotos</Typography>
          </li>
          <li>
            <Typography>&Ouml;ffnungszeiten, Kontaktinformationen und Ortsdetails</Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          <strong>
            Verlassen Sie sich nicht auf OpenMapX f&uuml;r sicherheitskritische Entscheidungen,
            Notfallnavigation, Katastrophenbew&auml;ltigung oder Situationen, in denen ungenaue
            Informationen zu Sch&auml;den f&uuml;hren k&ouml;nnten. Insbesondere k&ouml;nnen
            Waldbrand- und Erdbebendaten verz&ouml;gert oder unvollst&auml;ndig sein und d&uuml;rfen
            nicht als Ersatz f&uuml;r offizielle Katastrophenwarnungen verwendet werden.
          </strong>
        </Typography>
        <Typography sx={{ mt: 1 }}>
          OpenMapX ist ein kostenloser Dienst, der vollst&auml;ndig auf Drittanbieter-Datenquellen
          beruht, die au&szlig;erhalb der Kontrolle des Betreibers liegen. Der Betreiber garantiert
          weder eine ununterbrochene Verf&uuml;gbarkeit noch einen fehlerfreien Betrieb oder die
          Richtigkeit der angezeigten Daten. Ihre gesetzlichen Rechte bleiben unber&uuml;hrt.
        </Typography>
      </Section>

      <Section title="7. Haftungsbeschr&auml;nkung">
        <Typography>Die Haftung des Betreibers bestimmt sich wie folgt:</Typography>
        <ul>
          <li>
            <Typography>
              <strong>Unbeschr&auml;nkte Haftung.</strong> Der Betreiber haftet unbeschr&auml;nkt
              f&uuml;r Sch&auml;den, die durch Vorsatz oder grobe Fahrl&auml;ssigkeit verursacht
              wurden, f&uuml;r Sch&auml;den aus der Verletzung des Lebens, des K&ouml;rpers oder der
              Gesundheit sowie f&uuml;r jede sonstige Haftung, die nach geltendem Recht nicht
              ausgeschlossen oder beschr&auml;nkt werden kann.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Wesentliche Vertragspflichten.</strong> Bei einfacher Fahrl&auml;ssigkeit
              haftet der Betreiber nur f&uuml;r die Verletzung wesentlicher Vertragspflichten
              (Pflichten, deren Erf&uuml;llung die ordnungsgem&auml;&szlig;e Durchf&uuml;hrung des
              Vertrags &uuml;berhaupt erst erm&ouml;glicht und auf deren Einhaltung der Nutzer
              regelm&auml;&szlig;ig vertrauen darf). In diesen F&auml;llen ist die Haftung auf den
              vorhersehbaren, vertragstypischen Schaden begrenzt.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Sonstige Fahrl&auml;ssigkeit.</strong> Die Haftung f&uuml;r einfache
              Fahrl&auml;ssigkeit ist im &Uuml;brigen ausgeschlossen.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Die vorstehenden Haftungsbeschr&auml;nkungen gelten auch zugunsten der Mitarbeiter,
          Vertreter und Erf&uuml;llungsgehilfen des Betreibers.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          OpenMapX aggregiert Daten aus Drittanbieterquellen. Da der Dienst kostenlos bereitgestellt
          wird und auf externen Daten beruht, die au&szlig;erhalb der Kontrolle des Betreibers
          liegen, &uuml;bernimmt der Betreiber keine Gew&auml;hr f&uuml;r die Richtigkeit,
          Vollst&auml;ndigkeit oder Aktualit&auml;t der angezeigten Daten.
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
          jeweiligen Lizenzen. Sofern eine Lizenz gilt, f&uuml;hrt ein Klick auf den Lizenznamen zum
          vollst&auml;ndigen Lizenztext.
        </Typography>

        {generateAttributionSectionsFromManifests(integrations).map((section) => (
          <AttributionTable key={section.heading} heading={section.headingDe} rows={section.rows} />
        ))}

        <TransitFeedAttribution
          feeds={transitAttribution as never[]}
          labels={{
            heading: "GTFS-Nahverkehrsfeeds",
            description:
              "Daten aus {count} Nahverkehrsfeeds aus {countries} L\u00e4ndern, bezogen \u00fcber den Transitous-Katalog.",
            fallback: (
              <>
                Verschiedene Verkehrsunternehmen via{" "}
                <Link
                  href="https://transitous.org/sources/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Transitous-Katalog
                </Link>
                . Lizenz variiert je Feed.
              </>
            ),
            source: "Quelle",
            feedName: "Feed",
            license: "Lizenz",
            operators: "Betreiber",
            feeds: "Feeds",
          }}
        />
      </Section>

      <Section title="11. Drittanbieter-Bedingungen">
        <Typography>
          Ihre Nutzung der &uuml;ber OpenMapX angezeigten Daten kann den Nutzungsbedingungen der
          jeweiligen oben aufgef&uuml;hrten Drittanbieter-Datenquellen unterliegen. Durch die
          Nutzung von Funktionen, die von diesen Anbietern bereitgestellt werden, stimmen Sie auch
          deren Nutzungsbedingungen zu, soweit anwendbar. Insbesondere sind aus OpenStreetMap
          stammende Daten unter der ODbL verf&uuml;gbar, die Namensnennung und Share-Alike f&uuml;r
          abgeleitete Datenbanken erfordert.
        </Typography>
      </Section>

      <Section title="12. Salvatorische Klausel">
        <Typography>
          Sollte eine Bestimmung dieser Bedingungen f&uuml;r unwirksam oder undurchsetzbar befunden
          werden, bleiben die &uuml;brigen Bestimmungen in vollem Umfang g&uuml;ltig und wirksam.
          Die unwirksame Bestimmung wird durch eine g&uuml;ltige Bestimmung ersetzt, die der
          urspr&uuml;nglichen Absicht am n&auml;chsten kommt.
        </Typography>
      </Section>

      <Section title="13. Anwendbares Recht und Gerichtsstand">
        <Typography>
          Diese Bedingungen unterliegen dem Recht der Bundesrepublik Deutschland unter Ausschluss
          des UN-Kaufrechts (CISG). Sind Sie Verbraucher innerhalb der EU, genie&szlig;en Sie
          zus&auml;tzlich den Schutz zwingender Bestimmungen des Rechts Ihres Wohnsitzlandes.
          Ausschlie&szlig;licher Gerichtsstand f&uuml;r alle Streitigkeiten aus oder im Zusammenhang
          mit diesen Bedingungen ist {jurisdictionCity}, Deutschland, sofern nicht zwingende
          Verbraucherschutzgesetze etwas anderes vorsehen.
        </Typography>
      </Section>

      <Section title="14. &Auml;nderungen dieser Bedingungen">
        <Typography>
          Wir behalten uns das Recht vor, diese Bedingungen jederzeit zu aktualisieren. Die aktuelle
          Version ist stets unter <Link href="/terms">/terms</Link> verf&uuml;gbar. Wir werden
          registrierte Nutzer &uuml;ber wesentliche &Auml;nderungen mindestens 30&nbsp;Tage vor
          deren Inkrafttreten per E-Mail benachrichtigen. Wenn Sie mit den &Auml;nderungen nicht
          einverstanden sind, k&ouml;nnen Sie die Nutzung des Dienstes einstellen und Ihr Konto vor
          dem Inkrafttretungsdatum l&ouml;schen. Die fortgesetzte Nutzung des Dienstes nach dem
          mitgeteilten Inkrafttretungsdatum gilt als Zustimmung zu den ge&auml;nderten Bedingungen.
        </Typography>
      </Section>

      <Section title="15. Sprache">
        <Typography>
          Diese Bedingungen sind in deutscher und englischer Sprache verf&uuml;gbar. Bei
          Abweichungen zwischen den beiden Fassungen hat die deutsche Fassung Vorrang.
        </Typography>
      </Section>

      <Section title="16. Kontakt">
        <Typography>
          Wenn Sie Fragen zu diesen Bedingungen haben, kontaktieren Sie uns bitte unter{" "}
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
              <TableCell sx={{ fontWeight: 600 }}>Quelle</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Beschreibung</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Lizenz</TableCell>
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
