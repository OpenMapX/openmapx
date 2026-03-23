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

        <AttributionTable
          heading="Kartendaten und Geokodierung"
          rows={[
            {
              source: "OpenStreetMap",
              desc: "Kartendaten \u00a9 OpenStreetMap-Mitwirkende",
              license: "ODbL",
              licenseUrl: "https://opendatacommons.org/licenses/odbl/",
              url: "https://www.openstreetmap.org/",
            },
            {
              source: "MapTiler",
              desc: "Kartenkacheln, Stile und Geokodierung",
              license: "Propriet\u00e4r",
              url: "https://www.maptiler.com/",
            },
            {
              source: "OpenTopoMap",
              desc: "Topografische Kartenkacheln (OSM + SRTM-Daten)",
              license: "CC BY-SA 3.0",
              licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
              url: "https://opentopomap.org/",
            },
            {
              source: "CyclOSM",
              desc: "Fahrrad-fokussierte Kartenkacheln",
              license: "ODbL (OSM-Daten)",
              licenseUrl: "https://opendatacommons.org/licenses/odbl/",
              url: "https://www.cyclosm.org/",
            },
            {
              source: "Nominatim",
              desc: "Geokodierung und Reverse Geocoding",
              license: "ODbL (OSM-Daten)",
              licenseUrl: "https://opendatacommons.org/licenses/odbl/",
              url: "https://nominatim.openstreetmap.org/",
            },
            {
              source: "Photon (Komoot)",
              desc: "Alternativer Geokoder",
              license: "ODbL (OSM-Daten)",
              licenseUrl: "https://opendatacommons.org/licenses/odbl/",
              url: "https://photon.komoot.io/",
            },
            {
              source: "Overpass API",
              desc: "OSM-Datenabfragen f\u00fcr POIs, Wege, Haltestellen",
              license: "ODbL (OSM-Daten)",
              licenseUrl: "https://opendatacommons.org/licenses/odbl/",
              url: "https://overpass-api.de/",
            },
          ]}
        />

        <AttributionTable
          heading="Routenplanung"
          rows={[
            {
              source: "OSRM",
              desc: "Autorouten-Berechnung und -Optimierung",
              license: "BSD 2-Clause",
              licenseUrl: "https://github.com/Project-OSRM/osrm-backend/blob/master/LICENSE.TXT",
              url: "https://project-osrm.org/",
            },
            {
              source: "Valhalla (FOSSGIS e.V.)",
              desc: "Fu\u00dfg\u00e4nger-, Rad-, Autorouten; Isochronen; H\u00f6henprofile",
              license: "MIT",
              licenseUrl: "https://github.com/valhalla/valhalla/blob/master/LICENSE.md",
              url: "https://fossgis.de/",
            },
          ]}
        />

        <AttributionTable
          heading="Stra\u00dfenansicht"
          rows={[
            {
              source: "Mapillary",
              desc: "Stra\u00dfenfotos und Panoramen \u00a9 Mapillary-Mitwirkende",
              license: "CC BY-SA 4.0",
              licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
              url: "https://www.mapillary.com/",
            },
            {
              source: "Panoramax (IGN Frankreich)",
              desc: "Offene Stra\u00dfenpanoramen",
              license: "CC BY-SA 4.0",
              licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
              url: "https://panoramax.fr/",
            },
          ]}
        />

        <AttributionTable
          heading="Ortsfotos"
          rows={[
            {
              source: "Flickr (SmugMug)",
              desc: "CC-lizenzierte Ortsfotos (nur CC-Bilder angezeigt)",
              license: "Verschiedene CC",
              licenseUrl: "https://creativecommons.org/licenses/",
              url: "https://www.flickr.com/",
            },
            {
              source: "Wikimedia Commons",
              desc: "Geo-getaggte, frei lizenzierte Bilder",
              license: "Verschiedene freie Lizenzen",
              url: "https://commons.wikimedia.org/",
            },
          ]}
        />

        <AttributionTable
          heading="Verkehr"
          rows={[
            {
              source: "TomTom",
              desc: "Verkehrsflussdaten \u00a9 TomTom International BV",
              license: "Propriet\u00e4r",
              url: "https://www.tomtom.com/",
            },
          ]}
        />

        <AttributionTable
          heading="\u00d6ffentlicher Nahverkehr"
          rows={[
            {
              source: "Transitous (MOTIS)",
              desc: "Offenes multimodales Nahverkehrsrouting",
              license: "MIT",
              licenseUrl: "https://github.com/motis-project/motis/blob/master/LICENSE",
              url: "https://transitous.org/",
            },
            {
              source: "Deutsche Bahn RIS",
              desc: "Bahndaten \u00a9 DB InfraGO AG / DB Fernverkehr AG",
              license: "CC BY 4.0",
              licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
              url: "https://developers.deutschebahn.com/",
            },
            {
              source: "TransitLand",
              desc: "Nahverkehrsdatenaggregation von Interline Technologies",
              license: "Verschiedene je Feed",
              url: "https://www.transit.land/",
            },
            {
              source: "TfL",
              desc: "TfL Open Data; enth\u00e4lt OS-Daten \u00a9 Crown Copyright",
              license: "OGL v3.0",
              licenseUrl:
                "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
              url: "https://tfl.gov.uk/",
            },
            {
              source: "MBTA",
              desc: "Massachusetts Bay Transportation Authority",
              license: "MassDOT Open Data",
              url: "https://www.mbta.com/",
            },
            {
              source: "iRail",
              desc: "Belgische Bahndaten (Open Knowledge Belgium)",
              license: "Offene Daten",
              url: "https://docs.irail.be/",
            },
            {
              source: "transport.opendata.ch",
              desc: "Schweizer \u00f6ffentliche Verkehrsdaten",
              license: "Offene Daten",
              url: "https://transport.opendata.ch/",
            },
            {
              source: "GTFS-Feeds",
              desc: "Verschiedene Verkehrsunternehmen via Transitous-Katalog",
              license: "Verschiedene je Feed",
              url: "https://github.com/transitous/transitous",
            },
            {
              source: "Dynamische Nahverkehrsanbieter",
              desc: "~85 regionale APIs via offenem Verzeichnis",
              license: "Verschiedene je Anbieter",
              url: "https://github.com/public-transport/transport-apis",
            },
          ]}
        />

        <AttributionTable
          heading="Luftqualit\u00e4t und Naturkatastrophen"
          rows={[
            {
              source: "OpenAQ",
              desc: "Luftqualit\u00e4tsmessungen staatlicher Messnetze weltweit",
              license: "CC BY 4.0",
              licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
              url: "https://openaq.org/",
            },
            {
              source: "NASA FIRMS",
              desc: "Waldbrand-/Hotspot-Erkennungen (VIIRS, MODIS)",
              license: "Public Domain (US Gov)",
              url: "https://firms.modaps.eosdis.nasa.gov/",
            },
            {
              source: "USGS",
              desc: "Erdbebenstandorte, Magnituden und Tiefen",
              license: "Public Domain (US Gov)",
              url: "https://earthquake.usgs.gov/",
            },
          ]}
        />

        <AttributionTable
          heading="Wandern und Outdoor"
          rows={[
            {
              source: "Waymarked Trails",
              desc: "Wander- und Radweg-Daten und Overlay-Kacheln",
              license: "ODbL (OSM-Daten)",
              licenseUrl: "https://opendatacommons.org/licenses/odbl/",
              url: "https://waymarkedtrails.org/",
            },
            {
              source: "Refuges.info",
              desc: "Bergh\u00fctten und Schutzh\u00e4user (Community-Datenbank)",
              license: "CC BY-SA 2.0",
              licenseUrl: "https://creativecommons.org/licenses/by-sa/2.0/",
              url: "https://www.refuges.info/",
            },
          ]}
        />

        <AttributionTable
          heading="E-Ladestationen, Kraftstoffpreise und Parken"
          rows={[
            {
              source: "OpenChargeMap",
              desc: "E-Ladestationen: Standorte und Details",
              license: "CC BY-SA 4.0",
              licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
              url: "https://openchargemap.org/",
            },
            {
              source: "Tankerkoenig (MTS-K)",
              desc: "Deutsche Tankstellenpreise",
              license: "CC BY 4.0",
              licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
              url: "https://creativecommons.tankerkoenig.de/",
            },
            {
              source: "E-Control",
              desc: "\u00d6sterreichische Kraftstoffpreise",
              license: "\u00d6ffentliche Daten",
              url: "https://www.e-control.at/",
            },
            {
              source: "Franz\u00f6sische Regierung",
              desc: "Franz\u00f6sische Kraftstoffpreise",
              license: "Licence Ouverte v2.0",
              licenseUrl: "https://github.com/etalab/licence-ouverte/blob/master/LO.md",
              url: "https://www.prix-carburants.gouv.fr/",
            },
            {
              source: "Spanische Regierung",
              desc: "Spanische Kraftstoffpreise",
              license: "Staatliche Open Data",
              url: "https://datos.gob.es/",
            },
            {
              source: "DB BahnPark",
              desc: "Parken an deutschen Bahnh\u00f6fen",
              license: "CC BY 4.0",
              licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
              url: "https://www.dbbahnpark.de/",
            },
            {
              source: "ParkAPI / ParkenDD",
              desc: "Verf\u00fcgbarkeit \u00f6ffentlicher Parkpl\u00e4tze",
              license: "Verschiedene",
              url: "https://parkendd.de/",
            },
            {
              source: "MobiData BW",
              desc: "Parkdaten (Baden-W\u00fcrttemberg)",
              license: "CC BY 4.0",
              licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
              url: "https://mobidata-bw.de/",
            },
          ]}
        />

        <AttributionTable
          heading="Geteilte Mobilit\u00e4t"
          rows={[
            {
              source: "Deutsche Bahn GBFS",
              desc: "Call-a-Bike / StadtRad",
              license: "CC BY 4.0",
              licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
              url: "https://data.deutschebahn.com/",
            },
            {
              source: "Citybikes API",
              desc: "Globale Bike-Sharing-Daten",
              license: "Eigene Nutzungsbed.",
              url: "https://citybik.es/",
            },
            {
              source: "Nextbike",
              desc: "Bike-Sharing-Standorte",
              license: "Propriet\u00e4r",
              url: "https://www.nextbike.net/",
            },
            {
              source: "Cambio CarSharing",
              desc: "Carsharing-Verf\u00fcgbarkeit",
              license: "ODbL",
              licenseUrl: "https://opendatacommons.org/licenses/odbl/",
              url: "https://www.cambio-carsharing.de/",
            },
            {
              source: "Donkey Republic",
              desc: "Bike-Sharing-Stationen",
              license: "Propriet\u00e4r",
              url: "https://www.donkey.bike/",
            },
            {
              source: "Felyx",
              desc: "E-Moped-Sharing",
              license: "Propriet\u00e4r",
              url: "https://www.felyx.com/",
            },
            {
              source: "GO Sharing",
              desc: "E-Scooter- und E-Bike-Sharing",
              license: "Propriet\u00e4r",
              url: "https://go-sharing.com/",
            },
            {
              source: "Link (Superpedestrian)",
              desc: "E-Scooter-Sharing",
              license: "Propriet\u00e4r",
              url: "https://www.linkyour.city/",
            },
            {
              source: "Stadtteilauto (M\u00fcnster)",
              desc: "Regionales Carsharing",
              license: "dl-de/by-2-0",
              licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
              url: "https://www.stadtteilauto.com/",
            },
            {
              source: "GBFS-Katalog (MobilityData)",
              desc: "Verzeichnis geteilter Mobilit\u00e4tssysteme",
              license: "MobilityData-Lizenz",
              url: "https://mobilitydata.org/",
            },
          ]}
        />

        <AttributionTable
          heading="Ortsinformationen"
          rows={[
            {
              source: "Wikidata",
              desc: "Strukturierte Fakten (Einwohnerzahl, Daten usw.)",
              license: "CC0 1.0",
              licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
              url: "https://www.wikidata.org/",
            },
            {
              source: "Wikipedia",
              desc: "Artikelzusammenfassungen und Vorschaubilder",
              license: "CC BY-SA 4.0",
              licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
              url: "https://www.wikipedia.org/",
            },
            {
              source: "Wikimedia Commons",
              desc: "Bilder und Metadaten",
              license: "Verschiedene freie Lizenzen",
              url: "https://commons.wikimedia.org/",
            },
          ]}
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
              <TableRow key={row.source}>
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
