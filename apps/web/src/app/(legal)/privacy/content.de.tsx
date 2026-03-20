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
          E-Mail: {email}
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
              Bereitstellung des Kartendienstes (Kartenkacheln, Suche, Routenplanung)
            </Typography>
          </li>
          <li>
            <Typography>Verwaltung von Benutzerkonten (sofern Sie ein Konto erstellen)</Typography>
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
          zu gew&auml;hrleisten. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO (berechtigtes
          Interesse an der Bereitstellung eines sicheren und funktionsf&auml;higen Dienstes).
          Server-Protokolle werden nach 30 Tagen automatisch gel&ouml;scht.
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
              Umgebungssuche)
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Rechtsgrundlage ist Art. 6 Abs. 1 lit. a DSGVO (Ihre ausdr&uuml;ckliche Einwilligung
          &uuml;ber die Browser-Berechtigungsabfrage).
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
              <strong>Sitzungsdaten</strong> &mdash; Authentifizierungs-Cookies, um Sie angemeldet
              zu halten
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
          Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO (Vertragserf&uuml;llung / Bereitstellung
          des von Ihnen angeforderten Dienstes). Sie k&ouml;nnen Ihr Konto jederzeit &uuml;ber die
          Kontoeinstellungen l&ouml;schen.
        </Typography>
      </Section>

      <Section title="6. Drittanbieter-Dienste und Daten&uuml;bermittlungen">
        <Typography>
          Um seine Kartenfunktionen bereitzustellen, sendet OpenMapX Anfragen an verschiedene
          Drittanbieter-APIs. Wenn Sie eine Funktion nutzen, werden bestimmte Daten (typischerweise
          Kartenausschnitt-Koordinaten, Suchanfragen oder Routenwegpunkte) an den jeweiligen
          Anbieter &uuml;bermittelt. Nachfolgend eine vollst&auml;ndige Liste aller externen
          Dienste:
        </Typography>

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 2, mb: 1 }}>
          6.1 Kartenkacheln und Darstellung
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "MapTiler",
              purpose: "Basiskartenkacheln (Stra\u00dfen, Satellit, Gel\u00e4nde)",
              dataSent: "Kartenausschnitt-Koordinaten, Zoomstufe",
              country: "Schweiz",
              privacy: "https://www.maptiler.com/privacy-policy/",
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
              dataSent: "Suchanfragen, Begrenzungsrahmen",
              country: "Schweiz",
              privacy: "https://www.maptiler.com/privacy-policy/",
            },
            {
              service: "Nominatim (OpenStreetMap Foundation)",
              purpose: "Adresssuche, Reverse Geocoding, Ortsanreicherung",
              dataSent: "Suchanfragen, Koordinaten",
              country: "UK / Verschiedene",
              privacy: "https://osmfoundation.org/wiki/Privacy_Policy",
            },
            {
              service: "Photon (Komoot)",
              purpose: "Adresssuche (alternativer Anbieter)",
              dataSent: "Suchanfragen",
              country: "Deutschland",
              privacy: "https://www.komoot.com/privacy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.3 Routenplanung und Navigation
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OSRM (\u00f6ffentliche Demo)",
              purpose: "Autorouten-Berechnung",
              dataSent: "Start-/Zielkoordinaten, Routenoptionen",
              country: "Deutschland",
              privacy: "https://project-osrm.org/",
            },
            {
              service: "Valhalla (FOSSGIS)",
              purpose: "Fu\u00dfg\u00e4nger- und Fahrradrouten",
              dataSent: "Start-/Zielkoordinaten, Routing-Modus",
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
              dataSent: "Kartenkachel-Koordinaten",
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
              service: "Mapillary (Meta)",
              purpose: "Stra\u00dfenfotos und Abdeckung",
              dataSent: "Koordinaten, Begrenzungsrahmen",
              country: "USA",
              privacy: "https://www.mapillary.com/privacy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.6 &Ouml;ffentlicher Nahverkehr
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "TransitLand",
              purpose: "Haltestellen und Linien",
              dataSent: "Begrenzungsrahmen, Haltestellen-/Linienabfragen",
              country: "USA",
              privacy: "https://www.transit.land/terms",
            },
            {
              service: "Transitous (MOTIS)",
              purpose: "Multimodale Fahrplanauskunft",
              dataSent: "Start-/Zielkoordinaten, Datum/Uhrzeit",
              country: "Deutschland",
              privacy: "https://transitous.org/",
            },
            {
              service: "transport.rest (DB, VBB, BVG)",
              purpose: "Deutsche Nahverkehrsdaten",
              dataSent: "Haltestellenabfragen, Verbindungsanfragen",
              country: "Deutschland",
              privacy: "https://transport.rest/",
            },
            {
              service: "Transport for London (TfL)",
              purpose: "Londoner Nahverkehrsdaten",
              dataSent: "Haltestellen-/Linienabfragen",
              country: "UK",
              privacy: "https://tfl.gov.uk/corporate/privacy-and-cookies/",
            },
            {
              service: "MBTA",
              purpose: "Nahverkehr im Raum Boston",
              dataSent: "Haltestellen-/Prognoseabfragen",
              country: "USA",
              privacy: "https://www.mbta.com/policies/privacy-policy",
            },
            {
              service: "iRail",
              purpose: "Belgische Bahndaten",
              dataSent: "Bahnhofs-/Verbindungsabfragen",
              country: "Belgien",
              privacy: "https://hello.irail.be/privacy/",
            },
            {
              service: "transport.opendata.ch",
              purpose: "Schweizer Nahverkehrsdaten",
              dataSent: "Bahnhofs-/Verbindungsabfragen",
              country: "Schweiz",
              privacy: "https://transport.opendata.ch/",
            },
            {
              service: "Overpass API",
              purpose: "Haltestellendaten aus OpenStreetMap (Fallback)",
              dataSent: "Begrenzungsrahmen-Abfragen",
              country: "Deutschland",
              privacy: "https://wiki.openstreetmap.org/wiki/Overpass_API",
            },
            {
              service: "Dynamische Nahverkehrsanbieter (via public-transport/transport-apis)",
              purpose:
                "Zus\u00e4tzliche regionale Nahverkehrs-APIs, die zur Laufzeit aus einem offenen Verzeichnis ermittelt werden",
              dataSent: "Haltestellen-/Verbindungsabfragen (variiert je nach Anbieter)",
              country: "Verschiedene",
              privacy: "https://github.com/public-transport/transport-apis",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.7 Luftqualit&auml;t
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OpenAQ",
              purpose: "Luftqualit\u00e4tsmessungen (PM2,5, AQI)",
              dataSent: "Begrenzungsrahmen",
              country: "USA",
              privacy: "https://openaq.org/privacy/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.8 E-Ladestationen
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OpenChargeMap",
              purpose: "Standorte und Details von E-Ladestationen",
              dataSent: "Begrenzungsrahmen, Filterparameter",
              country: "UK",
              privacy: "https://openchargemap.org/site/profile/privacy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.9 Kraftstoffpreise
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Tankerkoenig",
              purpose: "Deutsche Tankstellenpreise",
              dataSent: "Begrenzungsrahmen",
              country: "Deutschland",
              privacy: "https://creativecommons.tankerkoenig.de/",
            },
            {
              service:
                "Franz\u00f6sische / Spanische / \u00d6sterreichische staatliche Kraftstoff-APIs",
              purpose: "Regionale Kraftstoffpreisdaten",
              dataSent: "Begrenzungsrahmen oder Regionskennungen",
              country: "Frankreich / Spanien / \u00d6sterreich",
              privacy: "Jeweilige staatliche Open-Data-Portale",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.10 Geteilte Mobilit&auml;t (Fahrr&auml;der, Roller, Carsharing)
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Deutsche Bahn GBFS",
              purpose: "Deutsches Bike-Sharing (Call-a-Bike, StadtRad)",
              dataSent: "Begrenzungsrahmen",
              country: "Deutschland",
              privacy: "https://www.bahn.de/datenschutz",
            },
            {
              service: "Citybikes API",
              purpose: "Globale Bike-Sharing-Stationsdaten",
              dataSent: "Begrenzungsrahmen",
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
              service: "Cambio",
              purpose: "Carsharing-Verf\u00fcgbarkeit",
              dataSent: "Begrenzungsrahmen",
              country: "Deutschland / Belgien",
              privacy: "https://www.cambio-carsharing.de/datenschutz",
            },
            {
              service: "Felyx, Link, GO Sharing, Donkey Republic",
              purpose: "E-Scooter- und Bike-Sharing-Standorte",
              dataSent: "Koordinaten oder Begrenzungsrahmen",
              country: "Verschiedene (EU)",
              privacy: "Siehe jeweilige Anbieter-Websites",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.11 Ortsanreicherung
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "Wikidata / Wikipedia / Wikimedia Commons",
              purpose: "Ortsbeschreibungen, Fotos, strukturierte Fakten",
              dataSent: "Ortskennungen, Suchanfragen",
              country: "USA (Wikimedia Foundation)",
              privacy: "https://foundation.wikimedia.org/wiki/Privacy_policy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          6.12 Authentifizierungsanbieter
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OpenStreetMap OAuth",
              purpose: "Anmeldung \u00fcber OSM-Konto",
              dataSent: "OAuth-Autorisierungsablauf (kein Passwort wird geteilt)",
              country: "UK",
              privacy: "https://osmfoundation.org/wiki/Privacy_Policy",
            },
            {
              service: "Mapillary OAuth",
              purpose: "Anmeldung \u00fcber Mapillary-Konto",
              dataSent: "OAuth-Autorisierungsablauf (kein Passwort wird geteilt)",
              country: "USA",
              privacy: "https://www.mapillary.com/privacy",
            },
          ]}
        />

        <Typography sx={{ mt: 2 }}>
          <strong>Internationale &Uuml;bermittlungen:</strong> Einige der oben genannten Dienste
          werden von Unternehmen in den USA oder anderen L&auml;ndern au&szlig;erhalb des
          Europ&auml;ischen Wirtschaftsraums (EWR) betrieben. Soweit Daten in Drittl&auml;nder
          &uuml;bermittelt werden, st&uuml;tzen wir uns auf das EU-U.S. Data Privacy Framework,
          Standardvertragsklauseln oder die Einhaltung gleichwertiger Schutzma&szlig;nahmen durch
          den Anbieter gem&auml;&szlig; Art. 46 DSGVO. Rechtsgrundlage f&uuml;r alle
          Drittanbieter-Anfragen ist Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an der
          Bereitstellung des von Ihnen genutzten Kartendienstes).
        </Typography>
      </Section>

      <Section title="7. Cookies und lokaler Speicher">
        <Typography>
          OpenMapX verwendet ausschlie&szlig;lich technisch notwendige Speichermechanismen:
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Sitzungs-Cookies</strong> &mdash; Wenn Sie sich anmelden, wird ein
              Sitzungs-Cookie gesetzt, um Ihre Anfragen zu authentifizieren. Dieses Cookie ist
              f&uuml;r die Anmeldefunktion unerlässlich und wird gel&ouml;scht, wenn Sie sich
              abmelden oder es abl&auml;uft.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Service-Worker-Cache</strong> &mdash; In der Produktionsumgebung speichert ein
              Service Worker statische Ressourcen (HTML, CSS, JavaScript) f&uuml;r die
              Offline-Verf&uuml;gbarkeit. Es werden keine personenbezogenen Daten gespeichert.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Browser-Speicher-Cache</strong> &mdash; API-Antworten (Suchergebnisse, Routen)
              werden w&auml;hrend Ihrer Sitzung im Browserspeicher zwischengespeichert. Diese Daten
              werden beim Schlie&szlig;en des Tabs verworfen.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Wir verwenden <strong>keine</strong> Tracking-Cookies, Analyse-Cookies oder Werbe-Cookies.
          Ein Cookie-Consent-Banner ist nicht erforderlich, da wir ausschlie&szlig;lich technisch
          notwendige Cookies verwenden (&sect; 25 Abs. 2 TDDDG).
        </Typography>
      </Section>

      <Section title="8. Serverseitiges Caching">
        <Typography>
          Um die Leistung zu verbessern und die Last auf Drittanbieter-APIs zu reduzieren, speichert
          unser Server API-Antworten in Redis (einem In-Memory-Datenspeicher) zwischen.
          Zwischengespeicherte Daten umfassen typischerweise Kartensuchergebnisse, Fahrpl&auml;ne
          und Routenantworten. Cache-Eintr&auml;ge laufen automatisch ab (in der Regel innerhalb von
          Minuten bis 24 Stunden). Der Cache speichert keine personenbezogenen Daten wie IP-Adressen
          oder Kontoinformationen.
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
          Marketing-E-Mails.
        </Typography>
      </Section>

      <Section title="10. Ihre Rechte nach der DSGVO">
        <Typography>
          Sie haben folgende Rechte bez&uuml;glich Ihrer personenbezogenen Daten:
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Auskunftsrecht</strong> (Art. 15 DSGVO) &mdash; Sie k&ouml;nnen Auskunft
              dar&uuml;ber verlangen, welche personenbezogenen Daten wir verarbeiten.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Recht auf Berichtigung</strong> (Art. 16 DSGVO) &mdash; Sie k&ouml;nnen die
              Berichtigung unrichtiger Daten verlangen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Recht auf L&ouml;schung</strong> (Art. 17 DSGVO) &mdash; Sie k&ouml;nnen die
              L&ouml;schung Ihrer Daten verlangen. Sie k&ouml;nnen Ihr Konto auch direkt in den
              Kontoeinstellungen l&ouml;schen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Recht auf Einschr&auml;nkung der Verarbeitung</strong> (Art. 18 DSGVO) &mdash;
              Sie k&ouml;nnen verlangen, dass wir die Verarbeitung Ihrer Daten einschr&auml;nken.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Recht auf Daten&uuml;bertragbarkeit</strong> (Art. 20 DSGVO) &mdash; Sie
              k&ouml;nnen verlangen, Ihre Daten in einem strukturierten, g&auml;ngigen,
              maschinenlesbaren Format zu erhalten.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Widerspruchsrecht</strong> (Art. 21 DSGVO) &mdash; Sie k&ouml;nnen jederzeit
              der Verarbeitung auf Grundlage berechtigter Interessen widersprechen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Recht auf Widerruf der Einwilligung</strong> (Art. 7 Abs. 3 DSGVO) &mdash;
              Soweit die Verarbeitung auf einer Einwilligung beruht (z.&nbsp;B. Standortdaten),
              k&ouml;nnen Sie diese jederzeit widerrufen, indem Sie die Browser-Berechtigung
              zur&uuml;ckziehen.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Um eines dieser Rechte auszu&uuml;ben, kontaktieren Sie uns unter der oben genannten
          E-Mail-Adresse. Sie haben au&szlig;erdem das Recht, Beschwerde bei einer
          Aufsichtsbeh&ouml;rde einzulegen (Art. 77 DSGVO). Zust&auml;ndige Beh&ouml;rde ist die
          Datenschutzaufsichtsbeh&ouml;rde des Bundeslandes, in dem der Verantwortliche seinen Sitz
          hat.
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
              <strong>Server-Protokolle</strong> &mdash; werden nach 30 Tagen automatisch
              gel&ouml;scht.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Cache-Daten</strong> &mdash; laufen automatisch innerhalb von Minuten bis 48
              Stunden ab.
            </Typography>
          </li>
        </ul>
      </Section>

      <Section title="12. Sicherheit">
        <Typography>
          Wir setzen angemessene technische und organisatorische Ma&szlig;nahmen zum Schutz Ihrer
          Daten ein, darunter verschl&uuml;sselte Verbindungen (TLS/HTTPS), gehashte Passw&ouml;rter
          und sichere Sitzungsverwaltung. Jedoch ist keine Methode der &Uuml;bertragung &uuml;ber
          das Internet zu 100 % sicher.
        </Typography>
      </Section>

      <Section title="13. Datenschutz von Kindern">
        <Typography>
          OpenMapX richtet sich nicht an Kinder unter 16 Jahren. Wir erheben wissentlich keine
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
