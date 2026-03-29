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

export default function PrivacyContentDe() {
  const { name, street, postalCode, city, country, email } = legalConfig;

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 1 }}>
        Datenschutzerkl&auml;rung
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
        Zuletzt aktualisiert: M&auml;rz 2026
      </Typography>

      <Section title="1. Verantwortlicher und Kontakt">
        <Typography>
          Der Verantwortliche f&uuml;r die Datenverarbeitung auf dieser Website im Sinne der
          Datenschutz-Grundverordnung (DSGVO) ist:
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
      </Section>

      <Section title="2. &Uuml;bersicht der Datenverarbeitung">
        <Typography>
          OpenMapX ist eine Open-Data-Kartenplattform. Wir sind bestrebt, die Verarbeitung
          personenbezogener Daten auf ein Minimum zu beschr&auml;nken. Wir verwenden{" "}
          <strong>keine</strong> Analyse-, Tracking- oder Werbedienste. Wir verkaufen oder teilen
          Ihre personenbezogenen Daten nicht zu Marketingzwecken mit Dritten.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Datenverarbeitung erfolgt in folgenden Zusammenh&auml;ngen:
        </Typography>
        <ul>
          <li>
            <Typography>
              Bereitstellung des Kartendienstes (Kartenkacheln, Suche, Routenplanung, Isochronen,
              H&ouml;henprofile)
            </Typography>
          </li>
          <li>
            <Typography>
              Anzeige von Drittanbieter-Datenebenen (Verkehr, Nahverkehr, Luftqualit&auml;t,
              Naturkatastrophen, Wanderwege, Stra&szlig;enansicht, Ortsfotos, Parken,
              Kraftstoffpreise, E-Ladestationen, geteilte Mobilit&auml;t)
            </Typography>
          </li>
          <li>
            <Typography>Verwaltung von Benutzerkonten (sofern Sie ein Konto erstellen)</Typography>
          </li>
          <li>
            <Typography>
              Clientseitige Speicherung von Einstellungen und gespeicherten Orten auf Ihrem
              Ger&auml;t
            </Typography>
          </li>
          <li>
            <Typography>Serverseitiges Caching zur Leistungsoptimierung</Typography>
          </li>
        </ul>
      </Section>

      <Section title="3. Hosting und Server-Protokolle">
        <Typography>
          Beim Besuch von OpenMapX &uuml;bermittelt Ihr Browser automatisch bestimmte technische
          Daten an unseren Server. Dazu k&ouml;nnen geh&ouml;ren:
        </Typography>
        <ul>
          <li>
            <Typography>IP-Adresse</Typography>
          </li>
          <li>
            <Typography>Datum und Uhrzeit der Anfrage</Typography>
          </li>
          <li>
            <Typography>Browsertyp und -version</Typography>
          </li>
          <li>
            <Typography>Betriebssystem</Typography>
          </li>
          <li>
            <Typography>Referrer-URL</Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Diese Daten werden verarbeitet, um den technischen Betrieb und die Sicherheit des Dienstes
          zu gew&auml;hrleisten. Rechtsgrundlage ist Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;f DSGVO
          (berechtigtes Interesse an der Bereitstellung eines sicheren und funktionsf&auml;higen
          Dienstes). Server-Protokolle werden nach 30&nbsp;Tagen automatisch gel&ouml;scht.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Unsere Server werden von der Hetzner Online GmbH, Industriestr.&nbsp;25, 91710
          Gunzenhausen, Deutschland, betrieben. Hetzner verarbeitet Daten in unserem Auftrag und
          ausschlie&szlig;lich nach unserer Weisung (Auftragsverarbeiter gem&auml;&szlig;
          Art.&nbsp;28 DSGVO). Ein Auftragsverarbeitungsvertrag liegt vor. Die Rechenzentren von
          Hetzner befinden sich in Deutschland und Finnland (EU).
        </Typography>
      </Section>

      <Section title="4. Standortdaten">
        <Typography>
          OpenMapX fordert den Standort Ihres Ger&auml;ts nur an, wenn Sie ausdr&uuml;cklich auf die
          Schaltfl&auml;che &quot;Mein Standort&quot; klicken. Ihr Browser fragt vor der Weitergabe
          dieser Daten um Erlaubnis. Standortdaten werden:
        </Typography>
        <ul>
          <li>
            <Typography>
              Ausschlie&szlig;lich verwendet, um die Karte auf Ihre Position zu zentrieren
            </Typography>
          </li>
          <li>
            <Typography>Nur in Ihrem Browser verarbeitet (clientseitig)</Typography>
          </li>
          <li>
            <Typography>
              Nicht auf unseren Servern gespeichert und nicht &uuml;bertragen, es sei denn, Sie
              nutzen aktiv Funktionen, die Koordinaten erfordern (z.&nbsp;B. Routenplanung,
              Umgebungssuche, Nahverkehrsabfahrten)
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Rechtsgrundlage ist Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;a DSGVO (Ihre ausdr&uuml;ckliche
          Einwilligung &uuml;ber die Browser-Berechtigungsabfrage).
        </Typography>
      </Section>

      <Section title="5. Benutzerkonten">
        <Typography>
          Sie k&ouml;nnen OpenMapX ohne Erstellung eines Kontos nutzen. Wenn Sie sich registrieren,
          verarbeiten wir:
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Name und E-Mail-Adresse</strong> &mdash; zur Kontoidentifikation und
              Kommunikation
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Passwort</strong> &mdash; wird ausschlie&szlig;lich als kryptografischer Hash
              gespeichert (niemals im Klartext)
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Passkeys (WebAuthn)</strong> &mdash; wenn Sie einen Passkey registrieren, wird
              ein &ouml;ffentlicher Schl&uuml;ssel auf unserem Server gespeichert; der private
              Schl&uuml;ssel verlässt niemals Ihr Ger&auml;t
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Sitzungsdaten</strong> &mdash; Authentifizierungs-Cookies, um Sie angemeldet
              zu halten
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Gespeicherte Orte</strong> &mdash; wenn Sie Orte speichern, w&auml;hrend Sie
              angemeldet sind, werden Ortsname, Koordinaten und zugeh&ouml;rige Metadaten in unserer
              Datenbank gespeichert, damit sie ger&auml;te&uuml;bergreifend synchronisiert werden
              k&ouml;nnen
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Sie k&ouml;nnen sich auch &uuml;ber OAuth-Drittanbieter anmelden (OpenStreetMap,
          Mapillary). In diesem Fall erhalten wir Ihre &ouml;ffentlichen Profilinformationen (Name,
          Profilbild-URL) vom jeweiligen Anbieter. Wir erhalten oder speichern Ihr Passwort f&uuml;r
          diese Anbieter nicht.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Rechtsgrundlage ist Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;b DSGVO (Vertragserf&uuml;llung /
          Bereitstellung des von Ihnen angeforderten Dienstes). Sie k&ouml;nnen Ihr Konto jederzeit
          &uuml;ber die Kontoeinstellungen l&ouml;schen.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Die Bereitstellung personenbezogener Daten ist weder gesetzlich noch vertraglich
          vorgeschrieben. Sie k&ouml;nnen OpenMapX ohne Angabe personenbezogener Daten nutzen. Die
          Erstellung eines Kontos erfordert eine E-Mail-Adresse; ohne diese k&ouml;nnen
          kontogebundene Funktionen (wie die Synchronisierung gespeicherter Orte) nicht
          bereitgestellt werden.
        </Typography>
      </Section>

      <Section title="6. Drittanbieter-Dienste und Daten&uuml;bermittlungen">
        <Typography>
          Um seine Kartenfunktionen bereitzustellen, sendet OpenMapX Anfragen an verschiedene
          Drittanbieter-APIs. Wenn Sie eine Funktion nutzen, werden bestimmte Daten (typischerweise
          Kartenausschnitt-Koordinaten, Suchanfragen oder Routenwegpunkte) an den jeweiligen
          Anbieter &uuml;bermittelt. Unser Backend-Server fungiert f&uuml;r die meisten dieser
          Anfragen als Proxy, sodass Drittanbieter in der Regel die IP-Adresse unseres Servers und
          nicht Ihre Browser-IP-Adresse sehen. Nachfolgend eine vollst&auml;ndige Liste aller
          externen Dienste:
        </Typography>

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 2, mb: 1 }}>
          6.1 Kartenkacheln und Darstellung
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "MapTiler",
              purpose: "Basiskartenkacheln (Stra\u00dfen, Satellit, Gel\u00e4nde), Kartenstile",
              dataSent: "Kartenausschnitt-Koordinaten, Zoomstufe, API-Schl\u00fcssel",
              country: "Schweiz",
              privacy: "https://www.maptiler.com/privacy-policy/",
            },
            {
              service: "OpenTopoMap",
              purpose: "Topografische Karten-Overlay",
              dataSent: "Kachelkoordinaten (z/x/y)",
              country: "Deutschland",
              privacy: "https://opentopomap.org/about",
            },
            {
              service: "CyclOSM (OpenStreetMap France)",
              purpose: "Fahrrad-fokussierte Kartenkacheln",
              dataSent: "Kachelkoordinaten (z/x/y)",
              country: "Frankreich",
              privacy: "https://www.openstreetmap.fr/",
            },
            {
              service: "Waymarked Trails (Kachel-Overlay)",
              purpose: "Radrouten-Overlay-Kacheln",
              dataSent: "Kachelkoordinaten (z/x/y)",
              country: "Deutschland",
              privacy: "https://cycling.waymarkedtrails.org/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.2 Geokodierung und Suche
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "MapTiler Geocoding",
              purpose: "Adress- und Ortssuche",
              dataSent: "Suchanfragen, Begrenzungsrahmen, Sprache",
              country: "Schweiz",
              privacy: "https://www.maptiler.com/privacy-policy/",
            },
            {
              service: "Nominatim (OpenStreetMap Foundation)",
              purpose: "Adresssuche, Reverse Geocoding, Ortsanreicherung",
              dataSent: "Suchanfragen, Koordinaten, Sprache",
              country: "UK / Verschiedene",
              privacy: "https://osmfoundation.org/wiki/Privacy_Policy",
            },
            {
              service: "Photon (Komoot)",
              purpose: "Adresssuche (alternativer Anbieter)",
              dataSent: "Suchanfragen, Sprache",
              country: "Deutschland",
              privacy: "https://www.komoot.com/privacy",
            },
            {
              service: "Transitous / MOTIS-Geokodierung",
              purpose: "Haltestellen- und Ortssuche",
              dataSent: "Suchanfragen, Sprache",
              country: "Deutschland",
              privacy: "https://transitous.org/privacy/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.3 Routenplanung, Isochronen und H&ouml;henprofile
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OSRM (\u00f6ffentlicher Demo-Server)",
              purpose: "Autorouten-Berechnung, Routenoptimierung",
              dataSent:
                "Wegpunkt-Koordinaten, Routenoptionen (Autobahnen/Maut/F\u00e4hren vermeiden)",
              country: "Deutschland",
              privacy: "https://project-osrm.org/",
            },
            {
              service: "Valhalla (FOSSGIS e.V.)",
              purpose:
                "Fu\u00dfg\u00e4nger-, Fahrrad- und Autorouten; Isochronen-Berechnung; H\u00f6henprofile",
              dataSent:
                "Wegpunkt-Koordinaten, Routing-Modus, Vermeidungsoptionen, Isochronen-Parameter, H\u00f6hen-Abtastpunkte",
              country: "Deutschland",
              privacy: "https://fossgis.de/datenschutzerkl%C3%A4rung/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.4 Verkehrsdaten
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "TomTom",
              purpose: "Live-Verkehrsfluss-Overlay",
              dataSent: "Kartenkachel-Koordinaten, API-Schl\u00fcssel",
              country: "Niederlande",
              privacy: "https://www.tomtom.com/privacy/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.5 Stra&szlig;enansicht
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Mapillary (Meta Platforms)",
              purpose: "Stra\u00dfenfotos, Panoramen und Abdeckungsebene",
              dataSent: "Koordinaten, Begrenzungsrahmen, Bild-IDs, Zugriffstoken",
              country: "USA",
              privacy: "https://www.mapillary.com/privacy",
            },
            {
              service: "Panoramax (IGN Frankreich)",
              purpose: "Offene Stra\u00dfenpanorama-Bilder",
              dataSent: "Koordinaten",
              country: "Frankreich",
              privacy: "https://panoramax.fr/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.6 Ortsfotos
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Flickr (SmugMug)",
              purpose: "CC-lizenzierte Ortsfotos f\u00fcr Fotogalerien",
              dataSent: "Koordinaten, Suchradius, API-Schl\u00fcssel",
              country: "USA",
              privacy: "https://www.flickr.com/help/privacy",
            },
            {
              service: "Wikimedia Commons (Wikimedia Foundation)",
              purpose: "Geo-getaggte, frei lizenzierte Fotos f\u00fcr Fotogalerien",
              dataSent: "Koordinaten, Suchradius",
              country: "USA",
              privacy: "https://foundation.wikimedia.org/wiki/Privacy_policy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.7 &Ouml;ffentlicher Nahverkehr
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Transitous (MOTIS)",
              purpose: "Multimodale Fahrplanauskunft (weltweit)",
              dataSent: "Start-/Zielkoordinaten, Datum/Uhrzeit, Verkehrsmittel",
              country: "Deutschland",
              privacy: "https://transitous.org/privacy/",
            },
            {
              service: "Deutsche Bahn RIS-APIs (Stations, Routing, Maps, Transports)",
              purpose: "Bahnhofsdaten, Verbindungsplanung, Streckengeometrie, Live-Zugpositionen",
              dataSent:
                "Bahnhofsabfragen, Koordinaten, Datum/Uhrzeit, Verbindungs-IDs, API-Zugangsdaten (serverseitig)",
              country: "Deutschland",
              privacy: "https://www.bahn.de/datenschutz",
            },
            {
              service: "TransitLand (Interline Technologies)",
              purpose: "Haltestellen, Linien und Abfahrten",
              dataSent:
                "Begrenzungsrahmen, Haltestellen-/Linienabfragen, API-Schl\u00fcssel (serverseitig)",
              country: "USA",
              privacy: "https://www.transit.land/terms",
            },
            {
              service: "Transport for London (TfL)",
              purpose: "Londoner Haltestellen, Linien, Ank\u00fcnfte und Betriebsmeldungen",
              dataSent:
                "Haltestellen-/Linienabfragen, Koordinaten, API-Schl\u00fcssel (serverseitig)",
              country: "UK",
              privacy: "https://tfl.gov.uk/corporate/privacy-and-cookies/",
            },
            {
              service: "MBTA (Massachusetts Bay Transportation Authority)",
              purpose: "Nahverkehr im Raum Boston: Haltestellen, Linien, Live-Abfahrten",
              dataSent:
                "Haltestellen-/Prognoseabfragen, Koordinaten, API-Schl\u00fcssel (serverseitig)",
              country: "USA",
              privacy: "https://www.mbta.com/policies/privacy-policy",
            },
            {
              service: "iRail",
              purpose: "Belgische Bahnh\u00f6fe, Verbindungen und Abfahrten",
              dataSent: "Bahnhofs-/Verbindungsabfragen",
              country: "Belgien",
              privacy: "https://docs.irail.be/",
            },
            {
              service: "transport.opendata.ch",
              purpose: "Schweizer Haltestellen, Verbindungen und Abfahrten",
              dataSent: "Bahnhofs-/Verbindungsabfragen",
              country: "Schweiz",
              privacy: "https://transport.opendata.ch/",
            },
            {
              service: "Overpass API (OpenStreetMap)",
              purpose: "Haltestellendaten aus OpenStreetMap (Fallback)",
              dataSent: "Begrenzungsrahmen-Abfragen (Overpass QL)",
              country: "Deutschland",
              privacy: "https://wiki.openstreetmap.org/wiki/Overpass_API",
            },
            {
              service:
                "Dynamische Nahverkehrsanbieter (via public-transport/transport-apis-Verzeichnis)",
              purpose:
                "Zus\u00e4tzliche regionale Nahverkehrs-APIs, die zur Laufzeit aus einem offenen Verzeichnis ermittelt werden (~85 Anbieter)",
              dataSent: "Haltestellen-/Verbindungsabfragen (variiert je nach Anbieter)",
              country: "Verschiedene",
              privacy: "https://github.com/public-transport/transport-apis",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.8 Luftqualit&auml;t
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OpenAQ",
              purpose: "Luftqualit\u00e4tsmessungen (PM2,5, AQI)",
              dataSent: "Begrenzungsrahmen-Koordinaten",
              country: "USA",
              privacy: "https://openaq.org/privacy/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.9 Naturkatastrophen-Daten
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "NASA FIRMS (Fire Information for Resource Management System)",
              purpose: "Aktive Waldbrand-/Hotspot-Erkennungen weltweit",
              dataSent: "Datenquellen-Auswahl, Zeitraum, API-Schl\u00fcssel (serverseitig)",
              country: "USA",
              privacy: "https://www.nasa.gov/privacy/",
            },
            {
              service: "USGS Earthquake Hazards Program",
              purpose: "Erdbebenstandorte, Magnituden und Tiefen",
              dataSent:
                "Zeitraum, Magnitudenschwelle (via vorgefertigter URL; keine Nutzerdaten \u00fcbermittelt)",
              country: "USA",
              privacy: "https://www.usgs.gov/privacy-policies",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.10 Wandern und Outdoor
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Waymarked Trails",
              purpose: "Wander- und Radweg-Metadaten (Name, Schwierigkeit, L\u00e4nge)",
              dataSent: "Suchanfragen, Begrenzungsrahmen",
              country: "Deutschland",
              privacy: "https://hiking.waymarkedtrails.org/",
            },
            {
              service: "Overpass API (OpenStreetMap)",
              purpose:
                "Wanderwege, Wintersportgebiete und andere Outdoor-Features aus OpenStreetMap",
              dataSent: "Overpass-QL-Abfragen mit Begrenzungsrahmen",
              country: "Deutschland",
              privacy: "https://wiki.openstreetmap.org/wiki/Overpass_API",
            },
            {
              service: "Refuges.info",
              purpose:
                "Bergh\u00fctten und Schutzh\u00e4user (Standorte, H\u00f6he, Kapazit\u00e4t)",
              dataSent: "Begrenzungsrahmen-Koordinaten",
              country: "Frankreich",
              privacy: "https://www.refuges.info/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.11 E-Ladestationen
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OpenChargeMap",
              purpose: "Standorte, Steckertypen und Verf\u00fcgbarkeit von E-Ladestationen",
              dataSent:
                "Begrenzungsrahmen, Filterparameter (Steckertyp, Nutzungsart), API-Schl\u00fcssel",
              country: "UK",
              privacy: "https://community.openchargemap.org/privacy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.12 Kraftstoffpreise
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Tankerkoenig (MTS-K)",
              purpose: "Deutsche Tankstellenpreise (E5, E10, Diesel)",
              dataSent: "Koordinaten, Suchradius, API-Schl\u00fcssel",
              country: "Deutschland",
              privacy: "https://creativecommons.tankerkoenig.de/",
            },
            {
              service: "E-Control Spritpreisrechner",
              purpose: "\u00d6sterreichische Tankstellenpreise",
              dataSent: "Adresse oder Koordinaten",
              country: "\u00d6sterreich",
              privacy: "https://meine.e-control.org/privacy-policy/",
            },
            {
              service: "Franz\u00f6sische staatliche Kraftstoffpreisdaten",
              purpose: "Franz\u00f6sische Tankstellenpreise",
              dataSent: "Koordinaten oder Regionskennungen",
              country: "Frankreich",
              privacy: "https://www.prix-carburants.gouv.fr/rubrique/donnees-personnelles/",
            },
            {
              service: "Spanische staatliche Kraftstoffpreisdaten",
              purpose: "Spanische Tankstellenpreise",
              dataSent: "Koordinaten oder Regionskennungen",
              country: "Spanien",
              privacy: "https://datos.gob.es/en/legal-notice",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.13 Parken
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "DB BahnPark (Deutsche Bahn)",
              purpose:
                "Parkeinrichtungen an deutschen Bahnh\u00f6fen (Kapazit\u00e4t, Auslastung, Preise)",
              dataSent: "API-Zugangsdaten (serverseitig)",
              country: "Deutschland",
              privacy: "https://www.bahn.de/datenschutz",
            },
            {
              service: "ParkAPI v2 (ParkenDD)",
              purpose:
                "Verf\u00fcgbarkeit \u00f6ffentlicher Parkpl\u00e4tze in verschiedenen europ\u00e4ischen St\u00e4dten",
              dataSent: "Stadtname-Abfrage",
              country: "Deutschland",
              privacy: "https://parkendd.de/",
            },
            {
              service: "ParkAPI v3 (MobiData BW)",
              purpose:
                "Parkplatzdaten mit Auslastung (Baden-W\u00fcrttemberg und dar\u00fcber hinaus)",
              dataSent: "Begrenzungsrahmen, Filterparameter",
              country: "Deutschland",
              privacy: "https://www.mobidata-bw.de/pages/datenschutz",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.14 Geteilte Mobilit&auml;t (Fahrr&auml;der, Roller, Carsharing)
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Deutsche Bahn GBFS (Call-a-Bike / StadtRad)",
              purpose: "DB-Bike-Sharing-Stationsdaten",
              dataSent: "API-Zugangsdaten (serverseitig)",
              country: "Deutschland",
              privacy: "https://www.bahn.de/datenschutz",
            },
            {
              service: "Citybikes API",
              purpose: "Globale Bike-Sharing-Stationsdaten",
              dataSent: "Netzwerk-/Stationsabfragen",
              country: "Verschiedene",
              privacy: "https://citybik.es/",
            },
            {
              service: "Nextbike",
              purpose: "Bike-Sharing-Standorte",
              dataSent: "Keine (gesamter Datensatz wird abgerufen)",
              country: "Deutschland",
              privacy: "https://www.nextbike.de/de/datenschutz/",
            },
            {
              service: "Cambio CarSharing",
              purpose: "Carsharing-Stations- und Fahrzeugverf\u00fcgbarkeit",
              dataSent: "Koordinaten",
              country: "Deutschland / Belgien",
              privacy: "https://www.cambio-carsharing.de/datenschutz",
            },
            {
              service: "Donkey Republic",
              purpose: "Bike-Sharing-Standorte",
              dataSent: "Koordinaten",
              country: "D\u00e4nemark",
              privacy: "https://www.donkey.bike/privacy-policy/",
            },
            {
              service: "Felyx",
              purpose: "E-Scooter-/Moped-Sharing-Standorte",
              dataSent: "Begrenzungsrahmen",
              country: "Niederlande",
              privacy: "https://www.felyx.com/",
            },
            {
              service: "GO Sharing",
              purpose: "E-Scooter- und E-Bike-Sharing-Standorte",
              dataSent: "Begrenzungsrahmen",
              country: "Niederlande",
              privacy: "https://go-sharing.com/terms-conditions/",
            },
            {
              service: "Link (Superpedestrian)",
              purpose: "E-Scooter-Sharing-Standorte",
              dataSent: "Koordinaten, Firmenkennung",
              country: "USA",
              privacy: "https://www.linkyour.city/privacy-policy",
            },
            {
              service: "Stadtteilauto (M\u00fcnster) und regionale Anbieter",
              purpose: "Regionale Carsharing-Stationen und Fahrzeugverf\u00fcgbarkeit",
              dataSent: "Keine (gesamter Datensatz abgerufen) oder Koordinaten",
              country: "Deutschland",
              privacy: "Siehe jeweilige Anbieter-Websites",
            },
            {
              service: "GBFS-Katalog (MobilityData)",
              purpose:
                "Verzeichnis von Bike-/Scooter-/Carsharing-Systemen weltweit (~1.200 Systeme)",
              dataSent: "Keine (statischer Katalog serverseitig abgerufen)",
              country: "Kanada",
              privacy: "https://mobilitydata.org/privacy-policy/",
            },
            {
              service: "Transitous Rentals (MOTIS)",
              purpose: "Leih-/Sharing-Fahrzeugstandorte via MOTIS-Anbieter",
              dataSent: "Koordinaten",
              country: "Deutschland",
              privacy: "https://transitous.org/privacy/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.15 Ortsanreicherung
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Wikipedia (Wikimedia Foundation)",
              purpose: "Ortsbeschreibungen, Artikelzusammenfassungen, Vorschaubilder",
              dataSent: "Artikeltitel, Sprachcode",
              country: "USA",
              privacy: "https://foundation.wikimedia.org/wiki/Privacy_policy",
            },
            {
              service: "Wikidata (Wikimedia Foundation)",
              purpose:
                "Strukturierte Ortsfakten (Einwohnerzahl, Gr\u00fcndungsdatum, Architekt usw.)",
              dataSent: "Wikidata-Entity-IDs",
              country: "USA",
              privacy: "https://foundation.wikimedia.org/wiki/Privacy_policy",
            },
            {
              service: "Wikimedia Commons (Wikimedia Foundation)",
              purpose: "Bild-Metadaten, Namensnennung und Lizenzinformationen",
              dataSent: "Dateinamen",
              country: "USA",
              privacy: "https://foundation.wikimedia.org/wiki/Privacy_policy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.16 Authentifizierungsanbieter
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OpenStreetMap OAuth 2.0",
              purpose: "Anmeldung \u00fcber OSM-Konto",
              dataSent: "OAuth-Autorisierungsablauf (kein Passwort wird an uns weitergegeben)",
              country: "UK",
              privacy: "https://osmfoundation.org/wiki/Privacy_Policy",
            },
            {
              service: "Mapillary OAuth (Meta Platforms)",
              purpose: "Anmeldung \u00fcber Mapillary-Konto",
              dataSent: "OAuth-Autorisierungsablauf (kein Passwort wird an uns weitergegeben)",
              country: "USA",
              privacy: "https://www.mapillary.com/privacy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.17 Software-Verzeichnisse und Kataloge
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "GitHub API (Microsoft)",
              purpose:
                "Abruf des Nahverkehrs-API-Verzeichnisses und GTFS-Feed-Katalogs aus Open-Source-Repositories (nur serverseitig)",
              dataSent:
                "Repository-Dateipfade; optional ein GitHub-Token zur Erh\u00f6hung der Rate-Limits",
              country: "USA",
              privacy:
                "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement",
            },
          ]}
        />

        <Typography sx={{ mt: 2 }}>
          <strong>Hinweis zum Datenfluss:</strong> F&uuml;r die meisten der oben genannten Dienste
          werden Anfragen &uuml;ber unseren Backend-Server geleitet (API-Proxy). Das bedeutet, dass
          der Drittanbieter in der Regel die IP-Adresse unseres Servers und nicht die Ihres Browsers
          erh&auml;lt. Ausnahmen sind Kartenkacheln, die direkt von Ihrem Browser geladen werden
          (MapTiler, OpenTopoMap, CyclOSM, Waymarked-Trails-Kachel-Overlays) sowie der
          MapillaryJS-Stra&szlig;enansicht-Viewer, bei dem Ihr Browser direkt mit dem Anbieter
          verbunden wird.
        </Typography>

        <Typography sx={{ mt: 2 }}>
          <strong>Internationale &Uuml;bermittlungen:</strong> Einige der oben genannten Dienste
          werden von Unternehmen in den USA oder anderen L&auml;ndern au&szlig;erhalb des
          Europ&auml;ischen Wirtschaftsraums (EWR) betrieben. Eine &Uuml;bermittlung
          personenbezogener Daten in ein Drittland findet nur statt, wenn Ihre Daten (z.&nbsp;B.
          Ihre IP-Adresse oder Koordinaten) tats&auml;chlich den jeweiligen Anbieter erreichen:
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Direkte Browser-Verbindungen zu US-Anbietern:</strong> Der
              MapillaryJS-Stra&szlig;enansicht-Viewer (Meta Platforms, Inc.) stellt eine direkte
              Verbindung von Ihrem Browser her, wodurch Ihre IP-Adresse und die betrachteten
              Koordinaten &uuml;bermittelt werden. Meta ist unter dem EU-U.S. Data Privacy Framework
              (DPF) zertifiziert.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Server-seitig weitergeleitete Koordinaten:</strong> F&uuml;r Dienste wie
              Flickr, Wikimedia Commons, TransitLand und Link kann unser Backend
              Kartenausschnitt-Koordinaten (nicht Ihre IP-Adresse) als Teil der Anfrage
              weiterleiten. Diese Koordinaten spiegeln den auf der Karte angezeigten Bereich wider
              und sind nicht unmittelbar mit Ihrer Identit&auml;t oder Ihrem physischen Standort
              verkn&uuml;pft.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Keine &Uuml;bermittlung personenbezogener Daten:</strong> Mehrere US-basierte
              Dienste (NASA FIRMS, USGS, GitHub API) erhalten keinerlei nutzerbezogene Daten. Unser
              Server ruft &ouml;ffentliche Daten-Feeds oder Repository-Dateien ab, ohne Koordinaten,
              Suchanfragen oder Nutzerkennungen zu &uuml;bermitteln. In diesen F&auml;llen findet
              keine &Uuml;bermittlung personenbezogener Daten statt.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Rechtsgrundlage f&uuml;r alle Drittanbieter-Anfragen ist Art.&nbsp;6 Abs.&nbsp;1
          lit.&nbsp;f DSGVO (berechtigtes Interesse an der Bereitstellung des von Ihnen genutzten
          Kartendienstes).
        </Typography>
      </Section>

      <Section title="7. Cookies und lokaler Speicher">
        <Typography>
          OpenMapX verwendet ausschlie&szlig;lich technisch notwendige Speichermechanismen. Jeder
          nachfolgende Punkt ist f&uuml;r die Bereitstellung des vom Nutzer angeforderten Dienstes
          erforderlich:
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Sitzungs-Cookie</strong> &mdash; Wenn Sie sich anmelden, wird ein
              HTTP-only-Sitzungs-Cookie gesetzt, um Ihre Anfragen zu authentifizieren. Dieses Cookie
              ist f&uuml;r die Anmeldefunktion unerl&auml;sslich und wird gel&ouml;scht, wenn Sie
              sich abmelden oder es abl&auml;uft.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Spracheinstellungs-Cookie</strong> (<code>NEXT_LOCALE</code>) &mdash; Wenn Sie
              die Sprache der Oberfl&auml;che explizit wechseln, wird Ihre Wahl (z.&nbsp;B.
              &quot;en&quot; oder &quot;de&quot;) in einem First-Party-Cookie (max-age: 1&nbsp;Jahr,
              SameSite: lax) gespeichert, damit die Oberfl&auml;che Ihre Wahl bei erneuten Besuchen
              beibeh&auml;lt. Dieses Cookie wird nur gesetzt, wenn Sie aktiv eine Sprache
              ausw&auml;hlen. Wenn Sie keine explizite Wahl getroffen haben, wird automatisch die
              Spracheinstellung Ihres Browsers verwendet, ohne ein Cookie zu speichern.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Ansichtseinstellungen</strong> &mdash; Eine kleine Anzahl von
              Anzeigeeinstellungen (z.&nbsp;B. Globus- vs. Flachkartenprojektion) wird im
              localStorage gespeichert, damit die Oberfl&auml;che Ihre zuletzt genutzte Ansicht
              wiederherstellt. Es sind keine personenbezogenen Daten betroffen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Service-Worker-Cache</strong> &mdash; Ein Service Worker speichert statische
              Ressourcen (HTML, CSS, JavaScript), Kartenkacheln und k&uuml;rzliche API-Antworten
              (Suchergebnisse, Routen) &uuml;ber die Cache-Storage-API des Browsers zwischen. Dies
              erm&ouml;glicht Offline-Funktionalit&auml;t und schnelleres Laden.
              Zwischengespeicherte Eintr&auml;ge laufen automatisch ab (statische Ressourcen:
              30&nbsp;Tage; Kartenkacheln: 3&ndash;7&nbsp;Tage; API-Antworten: Minuten bis
              1&nbsp;Tag). Es werden keine personenbezogenen Daten gespeichert.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Browser-Speicher-Cache</strong> &mdash; API-Antworten werden zus&auml;tzlich
              im Browserspeicher (via TanStack Query) w&auml;hrend Ihrer Sitzung
              zwischengespeichert. Diese Daten werden beim Schlie&szlig;en des Tabs verworfen.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Wir verwenden <strong>keine</strong> Tracking-Cookies, Analyse-Cookies oder Werbe-Cookies.
          Ein Cookie-Consent-Banner ist nicht erforderlich, da alle oben genannten
          Speichermechanismen f&uuml;r die Bereitstellung des angeforderten Dienstes unbedingt
          erforderlich sind (&sect;&nbsp;25 Abs.&nbsp;2 TDDDG, Umsetzung von Art.&nbsp;5 Abs.&nbsp;3
          ePrivacy-Richtlinie).
        </Typography>
      </Section>

      <Section title="8. Serverseitiges Caching und Datenbanken">
        <Typography>
          Um die Leistung zu verbessern und die Last auf Drittanbieter-APIs zu reduzieren, speichert
          unser Server API-Antworten in Redis (einem In-Memory-Datenspeicher) zwischen.
          Zwischengespeicherte Daten umfassen typischerweise Kartensuchergebnisse, Fahrpl&auml;ne,
          Routenantworten und Katalogdaten externer Verzeichnisse. Cache-Eintr&auml;ge laufen
          automatisch ab (in der Regel innerhalb von Minuten bis 48&nbsp;Stunden). Der Cache
          speichert keine personenbezogenen Daten wie IP-Adressen oder Kontoinformationen.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Wir betreiben au&szlig;erdem eine PostgreSQL-Datenbank f&uuml;r Benutzerkonten,
          gespeicherte Orte und gecachte Ortsanreicherungsdaten (z.&nbsp;B. Wikidata-Fakten,
          Wikipedia-Zusammenfassungen). Wenn GTFS-Nahverkehrs-Feeds importiert werden, werden
          Fahrplandaten (Haltestellennamen, Linien, Abfahrtszeiten) in separaten Datenbank-Schemas
          gespeichert. Diese Daten stellen keine personenbezogenen Daten von Endnutzern dar.
        </Typography>
      </Section>

      <Section title="9. E-Mail-Kommunikation">
        <Typography>
          Wenn Sie ein Konto registrieren, k&ouml;nnen wir transaktionale E-Mails senden f&uuml;r:
        </Typography>
        <ul>
          <li>
            <Typography>E-Mail-Adress-Verifizierung</Typography>
          </li>
          <li>
            <Typography>Passwort-Zur&uuml;cksetzungsanfragen</Typography>
          </li>
          <li>
            <Typography>Zwei-Faktor-Authentifizierungscodes</Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Diese E-Mails werden &uuml;ber einen SMTP-Server versendet und enthalten nur die f&uuml;r
          die jeweilige Aktion notwendigen Informationen. Wir versenden keine Newsletter oder
          Marketing-E-Mails. Rechtsgrundlage ist Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;b DSGVO
          (Vertragserf&uuml;llung / Bereitstellung des von Ihnen angeforderten Dienstes).
        </Typography>
      </Section>

      <Section title="10. Ihre Rechte nach der DSGVO">
        <Typography>
          Sie haben folgende Rechte bez&uuml;glich Ihrer personenbezogenen Daten:
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Auskunftsrecht</strong> (Art.&nbsp;15 DSGVO) &mdash; Sie k&ouml;nnen Auskunft
              dar&uuml;ber verlangen, welche personenbezogenen Daten wir verarbeiten.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Recht auf Berichtigung</strong> (Art.&nbsp;16 DSGVO) &mdash; Sie k&ouml;nnen
              die Berichtigung unrichtiger Daten verlangen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Recht auf L&ouml;schung</strong> (Art.&nbsp;17 DSGVO) &mdash; Sie k&ouml;nnen
              die L&ouml;schung Ihrer Daten verlangen. Sie k&ouml;nnen Ihr Konto auch direkt in den
              Kontoeinstellungen l&ouml;schen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Recht auf Einschr&auml;nkung der Verarbeitung</strong> (Art.&nbsp;18 DSGVO)
              &mdash; Sie k&ouml;nnen verlangen, dass wir die Verarbeitung Ihrer Daten
              einschr&auml;nken.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Recht auf Daten&uuml;bertragbarkeit</strong> (Art.&nbsp;20 DSGVO) &mdash; Sie
              k&ouml;nnen verlangen, Ihre Daten in einem strukturierten, g&auml;ngigen,
              maschinenlesbaren Format zu erhalten.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Widerspruchsrecht</strong> (Art.&nbsp;21 DSGVO) &mdash; Sie k&ouml;nnen
              jederzeit der Verarbeitung auf Grundlage berechtigter Interessen widersprechen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Recht auf Widerruf der Einwilligung</strong> (Art.&nbsp;7 Abs.&nbsp;3 DSGVO)
              &mdash; Soweit die Verarbeitung auf einer Einwilligung beruht (z.&nbsp;B.
              Standortdaten), k&ouml;nnen Sie diese jederzeit widerrufen, indem Sie die
              Browser-Berechtigung zur&uuml;ckziehen.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Um eines dieser Rechte auszu&uuml;ben, kontaktieren Sie uns unter der oben genannten
          E-Mail-Adresse. Sie haben au&szlig;erdem das Recht, Beschwerde bei einer
          Aufsichtsbeh&ouml;rde einzulegen (Art.&nbsp;77 DSGVO). Zust&auml;ndige
          Aufsichtsbeh&ouml;rde ist: Landesbeauftragte f&uuml;r Datenschutz und Informationsfreiheit
          Nordrhein-Westfalen (LDI NRW), Kavalleriestr.&nbsp;2&ndash;4, 40213 D&uuml;sseldorf,{" "}
          <Link href="https://www.ldi.nrw.de" target="_blank" rel="noopener noreferrer">
            www.ldi.nrw.de
          </Link>
          .
        </Typography>
      </Section>

      <Section title="11. Datenspeicherung">
        <Typography>Wir speichern personenbezogene Daten nur so lange wie n&ouml;tig:</Typography>
        <ul>
          <li>
            <Typography>
              <strong>Kontodaten</strong> &mdash; werden aufbewahrt, bis Sie Ihr Konto l&ouml;schen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Gespeicherte Orte</strong> &mdash; werden aufbewahrt, bis Sie sie entfernen
              oder Ihr Konto l&ouml;schen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Server-Protokolle</strong> &mdash; werden nach 30&nbsp;Tagen automatisch
              gel&ouml;scht.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Cache-Daten</strong> &mdash; laufen automatisch innerhalb von Minuten bis
              48&nbsp;Stunden ab.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Lokaler Speicher und Service-Worker-Cache</strong> &mdash; verbleibt auf Ihrem
              Ger&auml;t, bis Sie Ihre Browserdaten l&ouml;schen oder die Cache-Eintr&auml;ge
              automatisch ablaufen.
            </Typography>
          </li>
        </ul>
      </Section>

      <Section title="12. Sicherheit">
        <Typography>
          Wir setzen angemessene technische und organisatorische Ma&szlig;nahmen zum Schutz Ihrer
          Daten ein, darunter verschl&uuml;sselte Verbindungen (TLS/HTTPS), gehashte Passw&ouml;rter
          (mit modernen Schl&uuml;sselableitungsfunktionen), sichere Sitzungsverwaltung und
          parametrisierte Datenbankabfragen. Jedoch ist keine Methode der &Uuml;bertragung &uuml;ber
          das Internet zu 100&nbsp;% sicher.
        </Typography>
      </Section>

      <Section title="13. Datenschutz von Kindern">
        <Typography>
          OpenMapX richtet sich nicht an Kinder unter 16&nbsp;Jahren. Wir erheben wissentlich keine
          personenbezogenen Daten von Kindern. Wenn Sie glauben, dass ein Kind uns personenbezogene
          Daten &uuml;bermittelt hat, kontaktieren Sie uns bitte, damit wir diese l&ouml;schen
          k&ouml;nnen.
        </Typography>
      </Section>

      <Section title="14. &Auml;nderungen dieser Erkl&auml;rung">
        <Typography>
          Wir k&ouml;nnen diese Datenschutzerkl&auml;rung von Zeit zu Zeit aktualisieren. Die
          aktuelle Version ist stets unter <Link href="/privacy">/privacy</Link> verf&uuml;gbar.
          Wesentliche &Auml;nderungen werden durch Aktualisierung des Datums &quot;Zuletzt
          aktualisiert&quot; kenntlich gemacht.
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
}

function ServiceTable({ rows }: { rows: ServiceRow[] }) {
  return (
    <TableContainer sx={{ mt: 1, mb: 1 }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 600 }}>Dienst</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Zweck</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>&Uuml;bermittelte Daten</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Land</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Datenschutzinfo</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.service}>
              <TableCell>{row.service}</TableCell>
              <TableCell>{row.purpose}</TableCell>
              <TableCell>{row.dataSent}</TableCell>
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
