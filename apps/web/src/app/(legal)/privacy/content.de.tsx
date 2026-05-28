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
import { generatePrivacySectionsFromManifests } from "../generateLegalSections";

export default function PrivacyContentDe({
  capabilities: _capabilities = {},
  integrations = [],
}: {
  capabilities?: Record<string, boolean>;
  integrations?: import("@openmapx/integration-framework").LoadedIntegrationMeta[];
}) {
  const { name, street, postalCode, city, country, email } = legalConfig;

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 1 }}>
        Datenschutzerkl&auml;rung
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mb: 4,
        }}
      >
        Zuletzt aktualisiert: April 2026
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
          <li>
            <Typography>
              <strong>Mangrove-Bewertungs-Schl&uuml;sselpaar</strong> &mdash; wenn Sie die
              Bewertungsfunktion aktivieren, wird ein ECDSA-P-256-Signatur-Schl&uuml;sselpaar
              erzeugt und f&uuml;r Sie gespeichert. Der &ouml;ffentliche Schl&uuml;ssel wird im
              Klartext auf unserem Server abgelegt (er ist konzeptionell &ouml;ffentlich). Der
              private Schl&uuml;ssel wird je nach von Ihnen gew&auml;hltem Schutzmodus gespeichert:
            </Typography>
            <ul>
              <li>
                <Typography>
                  <strong>Passphrase (empfohlen)</strong> &mdash; der private Schl&uuml;ssel wird in
                  Ihrem Browser mit einer von Ihnen gew&auml;hlten Passphrase verschl&uuml;sselt,
                  und zwar mit dem auditierten{" "}
                  <Link
                    href="https://age-encryption.org/v1"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    age-Verschl&uuml;sselungsformat
                  </Link>{" "}
                  (scrypt-Schl&uuml;sselableitung und ChaCha20-Poly1305). Uns liegt
                  ausschlie&szlig;lich das Chiffrat vor.
                </Typography>
              </li>
              <li>
                <Typography>
                  <strong>Passphrase und/oder WebAuthn-Passkey</strong> &mdash; zus&auml;tzlich oder
                  alternativ k&ouml;nnen Sie den privaten Schl&uuml;ssel mit einem oder mehreren
                  registrierten Passkeys entsperren (z.&nbsp;B. Biometrie Ihres Ger&auml;ts,
                  Hardware-Sicherheitsschl&uuml;ssel). Wir speichern pro Passkey eine
                  age-plugin-fido2prf-Identit&auml;tskennung. Diese enth&auml;lt Credential-ID,
                  Relying-Party-ID und Transporthinweis, jedoch kein geheimes Material.
                </Typography>
              </li>
              <li>
                <Typography>
                  <strong>Unverschl&uuml;sselt (ausdr&uuml;ckliches Opt-in)</strong> &mdash; nur
                  wenn Sie dies aktiv w&auml;hlen, wird der private Schl&uuml;ssel im Klartext auf
                  unserem Server gespeichert. In diesem Modus k&ouml;nnten Personen mit
                  Datenbankzugriff (einschlie&szlig;lich des Betreibers) kryptografisch Bewertungen
                  in Ihrem Namen signieren. Wir zeigen vor dieser Wahl eine Warnung an.
                </Typography>
              </li>
            </ul>
          </li>
          <li>
            <Typography>
              <strong>Bewertungsinhalte</strong> &mdash; wenn Sie eine Bewertung abgeben, werden die
              von Ihnen bereitgestellten Inhalte (Sternebewertung, Freitext, optionale Bilder,
              optionale Interessenangaben, optionaler Erlebniskontext, Ortsreferenz) in Ihrem
              Browser kryptografisch signiert und anschlie&szlig;end von unserem Server an das
              Mangrove.reviews-Netzwerk weitergeleitet. Siehe Abschnitt&nbsp;6 zur
              Ver&ouml;ffentlichung.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Sie k&ouml;nnen sich auch &uuml;ber OAuth-Drittanbieter anmelden (OpenStreetMap,
          Mapillary). In diesem Fall erhalten wir Ihre &ouml;ffentlichen Profilinformationen (Name,
          Profilbild-URL) vom jeweiligen Anbieter. Ihr Browser wird w&auml;hrend der Autorisierung
          direkt zum ausgew&auml;hlten Anbieter weitergeleitet; dieser Anbieter kann dabei Ihre
          IP-Adresse und Browser-Anfragedaten erhalten. Wir erhalten oder speichern Ihr Passwort
          f&uuml;r diese Anbieter nicht.
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
      <Section title="6. Bewertungen (Mangrove Open Reviews Standard)">
        <Typography>
          OpenMapX bindet das dezentrale Bewertungsnetzwerk{" "}
          <Link href="https://mangrove.reviews/" target="_blank" rel="noopener noreferrer">
            Mangrove.reviews
          </Link>{" "}
          (Open Reviews Standard, betrieben von der Open Reviews Association, Z&uuml;rich, Schweiz)
          ein. Die Nutzung der Bewertungsfunktion hat Auswirkungen, die &uuml;ber unsere eigenen
          Server hinausgehen. Bitte lesen Sie diesen Abschnitt daher sorgf&auml;ltig, bevor Sie eine
          Bewertung abgeben.
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Bewertungen sind &ouml;ffentlich und dauerhaft.</strong> Wenn Sie eine
              Bewertung abgeben, wird diese mit Ihrem Schl&uuml;sselpaar (siehe Abschnitt&nbsp;5)
              signiert und an <code>api.mangrove.reviews</code> &uuml;bermittelt. Von dort wird sie
              von unabh&auml;ngigen Aggregatoren gespiegelt und weiterver&ouml;ffentlicht, die nicht
              unserer Kontrolle unterliegen. Die L&ouml;schung einer Bewertung ist eine
              Best-Effort-Anfrage an Aggregatoren; wir k&ouml;nnen die Entfernung aus bereits
              verbreiteten Kopien nicht garantieren.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Ihr &ouml;ffentlicher Schl&uuml;ssel ist ein dauerhaftes Pseudonym.</strong>{" "}
              Jede von Ihnen abgegebene Bewertung wird mit Ihrem &ouml;ffentlichen Schl&uuml;ssel
              signiert und mit ihm verkn&uuml;pft. Der &ouml;ffentliche Schl&uuml;ssel wird von
              Mangrove und den Aggregatoren im Klartext gespeichert und bindet alle Ihre Bewertungen
              sitzungs- und ger&auml;te&uuml;bergreifend zu einer pseudonymen Identit&auml;t
              zusammen. Jede Person, die eine Verbindung zwischen Ihrem &ouml;ffentlichen
              Schl&uuml;ssel und Ihrer realen Identit&auml;t herstellt, kann alle fr&uuml;heren und
              zuk&uuml;nftigen von Ihnen signierten Bewertungen zuordnen. Der Schl&uuml;ssel ist
              kein direkter Identifikator (Name, E-Mail usw.), ihn als anonym zu behandeln w&auml;re
              jedoch irref&uuml;hrend.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Was &uuml;bermittelt wird.</strong> Eine Bewertung enth&auml;lt: die
              Subjektkennung (f&uuml;r Orte ein <code>geo:</code>-URI mit Koordinaten und
              Unsicherheitsradius), Ihre Sternebewertung, einen optionalen Freitext, optionale
              Erlebnis-Tags, optionale Interessenangaben, optional hochgeladene Bilder, Ihren
              &ouml;ffentlichen Schl&uuml;ssel und Ihre Signatur.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Bild-Uploads.</strong> Optionale Bewertungsbilder werden an den Bilddienst von
              Mangrove hochgeladen (<code>files.mangrove.reviews</code>) und sind nach dem Hochladen
              &ouml;ffentlich abrufbar. Bevor Ihr Bild Ihren Browser verl&auml;sst, kodieren wir es
              &uuml;ber ein HTML-Canvas neu und entfernen dabei EXIF-, XMP-, IPTC-, GPS- und
              &auml;hnliche eingebettete Metadaten, die Kameras h&auml;ufig anh&auml;ngen. Der
              sichtbare Bildinhalt selbst bleibt erhalten und wird unver&auml;ndert
              ver&ouml;ffentlicht.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Abruf von Bewertungen.</strong> Wenn Sie einen Ort in OpenMapX ansehen, ruft
              unser Backend etwaige vorhandene Bewertungen zu diesem Ort von{" "}
              <code>api.mangrove.reviews</code> ab und &uuml;bermittelt dabei den <code>geo:</code>
              -URI des Orts (Koordinaten). Ihre IP-Adresse wird f&uuml;r Lesevorg&auml;nge nicht an
              Mangrove &uuml;bertragen, da diese &uuml;ber unseren Server laufen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Bearbeiten und L&ouml;schen eigener Bewertungen.</strong> Bearbeitungen und
              L&ouml;schungen sind selbst signierte Folgebewertungen. Sie werden auf dieselbe Weise
              wie die urspr&uuml;ngliche Bewertung verbreitet und unterliegen denselben Vorbehalten
              hinsichtlich Spiegelungen und Aufbewahrung durch Dritte.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Rechtsgrundlage f&uuml;r die Speicherung und Signatur Ihres Schl&uuml;sselpaars ist
          Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;b DSGVO (Durchf&uuml;hrung des von Ihnen angeforderten
          Bewertungsdienstes). Rechtsgrundlage f&uuml;r die Ver&ouml;ffentlichung der
          Bewertungsinhalte im Mangrove-Netzwerk ist Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;a DSGVO (Ihre
          ausdr&uuml;ckliche Einwilligung, erteilt durch Annahme der in der
          Bewertungs-Oberfl&auml;che eingeblendeten Nutzungsbedingungen/Datenschutz-Checkboxen und
          Best&auml;tigung &uuml;ber &bdquo;Ver&ouml;ffentlichen&ldquo;). Sie k&ouml;nnen eine
          zuk&uuml;nftige Einwilligung jederzeit widerrufen, indem Sie keine weiteren Bewertungen
          ver&ouml;ffentlichen; bereits ver&ouml;ffentlichte Bewertungen k&ouml;nnen aufgrund des
          dezentralen Designs des Systems nicht einseitig zur&uuml;ckgezogen werden.
        </Typography>
      </Section>
      <Section title="7. Drittanbieter-Dienste und Daten&uuml;bermittlungen">
        <Typography>
          Um seine Kartenfunktionen bereitzustellen, sendet OpenMapX Anfragen an verschiedene
          Drittanbieter-APIs. Wenn Sie eine Funktion nutzen, werden bestimmte Daten (typischerweise
          Kartenausschnitt-Koordinaten, Suchanfragen oder Routenwegpunkte) an den jeweiligen
          Anbieter &uuml;bermittelt. Unser Backend-Server fungiert f&uuml;r die meisten dieser
          Anfragen als Proxy, sodass Drittanbieter in der Regel die IP-Adresse unseres Servers und
          nicht Ihre Browser-IP-Adresse sehen. Nachfolgend eine vollst&auml;ndige Liste aller
          externen Dienste:
        </Typography>

        {generatePrivacySectionsFromManifests(integrations, "de").map((section) => (
          <div key={section.key}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
              {section.labelDe}
            </Typography>
            <ServiceTable rows={section.rows} />
          </div>
        ))}

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          Kernkartenanzeige
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "MapTiler Cloud",
              purpose:
                "Basiskartenstil, Vektorkacheln, Satellitenkacheln und Schrift-Glyphen, wenn MapTiler als Kartenanbieter konfiguriert ist",
              dataSent:
                "Karten-Asset-Anfragen und Kachelkoordinaten, die unser Backend-Proxy sendet; kann den sichtbaren Kartenausschnitt widerspiegeln",
              endUserExposure: "\u00dcber Server (Proxy)",
              country: "Schweiz",
              privacy: "https://www.maptiler.com/privacy-policy/",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          Authentifizierungsanbieter
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "OpenStreetMap OAuth 2.0",
              purpose: "Anmeldung \u00fcber OSM-Konto",
              dataSent:
                "Browser-Weiterleitung zur OSM-Autorisierungsseite; OAuth-Autorisierungsablauf (kein Passwort wird an uns weitergegeben)",
              endUserExposure: "Direkt (Browser)",
              country: "UK",
              privacy: "https://osmfoundation.org/wiki/Privacy_Policy",
            },
            {
              service: "Mapillary OAuth (Meta Platforms)",
              purpose: "Anmeldung \u00fcber Mapillary-Konto",
              dataSent:
                "Browser-Weiterleitung zur Mapillary-Autorisierungsseite; OAuth-Autorisierungsablauf (kein Passwort wird an uns weitergegeben)",
              endUserExposure: "Direkt (Browser)",
              country: "USA",
              privacy: "https://www.mapillary.com/privacy",
            },
          ]}
        />

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          Software-Verzeichnisse und Kataloge
        </Typography>
        <ServiceTable
          rows={[
            {
              service: "GitHub API (Microsoft)",
              purpose:
                "Abruf des Nahverkehrs-API-Verzeichnisses und GTFS-Feed-Katalogs aus Open-Source-Repositories (nur serverseitig)",
              dataSent: "Keine Nutzerdaten (serverseitige Repository-Dateiabfragen)",
              endUserExposure: "Nur Server",
              country: "USA",
              privacy:
                "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement",
            },
          ]}
        />

        <Typography sx={{ mt: 2 }}>
          <strong>Hinweis zum Datenfluss:</strong> Die Spalte &quot;Datenzugriff&quot; oben zeigt
          an, wie jeder Dienst kontaktiert wird. &quot;Nur Server&quot; und &quot;&Uuml;ber Server
          (Proxy)&quot; bedeuten, dass Anfragen &uuml;ber unseren Backend-Server geleitet werden
          &mdash; der Drittanbieter sieht nur die IP-Adresse unseres Servers, nicht Ihre.
          &quot;Direkt (Browser)&quot; bedeutet, dass Ihr Browser direkt mit dem Anbieter verbunden
          wird, wobei Ihre IP-Adresse und Ihr Browser-Fingerabdruck offengelegt werden.
          &quot;Gemischt&quot; bedeutet, dass Katalog- oder Metadaten-Anfragen serverseitig oder
          &uuml;ber Proxy laufen, einzelne Medien- oder Player-Assets aber direkt durch Ihren
          Browser geladen werden k&ouml;nnen, nachdem Sie eine ausdr&uuml;ckliche Aktion
          ausf&uuml;hren, etwa einen Viewer-Hinweis best&auml;tigen oder &quot;Medien laden&quot;
          anklicken. Die &uuml;berwiegende Mehrheit der Dienste ist serverseitig oder &uuml;ber
          Proxy angebunden. MapTiler-Karten-Assets werden standardm&auml;&szlig;ig &uuml;ber unseren
          API-Proxy geleitet. Wenn ein Betreiber &ouml;ffentliche Karten-, Stil- oder
          Kachel-URL-Vorlagen auf externe Anbieter konfiguriert, kontaktiert Ihr Browser diese
          konfigurierten Anbieter direkt f&uuml;r diese Assets.
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
              MapillaryJS-Stra&szlig;enansicht-Viewer (Meta Platforms, Inc.) wird erst geladen,
              nachdem Sie einen In-App-Hinweis best&auml;tigt haben. Anschlie&szlig;end stellt er
              eine direkte Verbindung von Ihrem Browser her, wodurch Ihre IP-Adresse,
              Browser-/Ger&auml;te-Anfragedaten, die ausgew&auml;hlte Bild-ID und die betrachteten
              Koordinaten &uuml;bermittelt werden. Einige Webcam-Video- oder Player-Anbieter
              k&ouml;nnen Ihre IP-Adresse ebenfalls erhalten, wenn Sie &quot;Medien laden&quot;
              anklicken oder Live-Medien anderweitig &ouml;ffnen. Meta ist unter dem EU-U.S. Data
              Privacy Framework (DPF) zertifiziert.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Proxy-Anfragen zu Anbietern au&szlig;erhalb des EWR:</strong> MapTiler Cloud
              erh&auml;lt proxy-weitergeleitete Karten-Asset-Anfragen, wenn es als Kartenanbieter
              konfiguriert ist. MapTiler AG sitzt in der Schweiz, f&uuml;r die ein
              EU-Angemessenheitsbeschluss besteht.
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
      <Section title="8. Cookies und lokaler Speicher">
        <Typography>
          OpenMapX verwendet ausschlie&szlig;lich First-Party-Speichermechanismen. Speicher, der
          f&uuml;r den Dienst erforderlich ist, wird ohne Consent-Banner verwendet. Der optionale
          Cache f&uuml;r k&uuml;rzliche Kartendaten ist standardm&auml;&szlig;ig deaktiviert und
          wird nur aktiviert, wenn Sie ihn in den Einstellungen einschalten.
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
              Ressourcen (HTML, CSS, JavaScript), Kartenkacheln und heruntergeladene
              Offline-Bereiche &uuml;ber die Cache-Storage-API des Browsers zwischen. Dies
              erm&ouml;glicht Offline-Funktionalit&auml;t und schnelleres Laden.
              Zwischengespeicherte Eintr&auml;ge laufen automatisch ab (statische Ressourcen:
              30&nbsp;Tage; Kartenkacheln: 3&ndash;7&nbsp;Tage). Laufzeit-Caches f&uuml;r
              API-Antworten zu Suche, Routen, Orten, Autovervollst&auml;ndigung, Wetter und
              Foto-Lookups werden nur geschrieben, wenn Sie den Cache f&uuml;r k&uuml;rzliche
              Kartendaten aktivieren.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Browser-Speicher-Cache</strong> &mdash; API-Antworten werden zus&auml;tzlich
              im Browserspeicher (via TanStack Query) w&auml;hrend Ihrer Sitzung
              zwischengespeichert. Diese Daten werden beim Schlie&szlig;en des Tabs verworfen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Optionaler Cache f&uuml;r k&uuml;rzliche Kartendaten</strong> &mdash; Wenn Sie
              in den Einstellungen &quot;K&uuml;rzliche Kartendaten auf diesem Ger&auml;t
              merken&quot; aktivieren, speichert OpenMapX eine kuratierte Auswahl k&uuml;rzlicher
              kartenbezogener API-Antworten in localStorage und Cache Storage. Dies kann eingegebene
              Suchtexte, Routen-Wegpunkte, Ortsdetails, Wetter-Lookups, Foto-Lookup-Ergebnisse,
              Ergebnisse in der N&auml;he und genaue Kartenkoordinaten umfassen. Eintr&auml;ge
              laufen je nach Cache-Typ automatisch ab (meist innerhalb von Minuten bis
              24&nbsp;Stunden; Foto-Lookup-Caches k&ouml;nnen bis zu 7&nbsp;Tage gespeichert
              bleiben). Sie k&ouml;nnen die Einstellung jederzeit deaktivieren oder diese Daten in
              den Speichereinstellungen l&ouml;schen.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Wir verwenden <strong>keine</strong> Tracking-Cookies, Analyse-Cookies oder Werbe-Cookies.
          F&uuml;r unbedingt erforderliche Speichermechanismen ist kein Cookie-Consent-Banner
          erforderlich (&sect;&nbsp;25 Abs.&nbsp;2 TDDDG, Umsetzung von Art.&nbsp;5 Abs.&nbsp;3
          ePrivacy-Richtlinie). Der optionale Cache f&uuml;r k&uuml;rzliche Kartendaten ist
          standardm&auml;&szlig;ig deaktiviert und wird &uuml;ber eine ausdr&uuml;ckliche
          First-Party-Einstellung gesteuert, nicht &uuml;ber ein Tracking-Banner.
        </Typography>
      </Section>
      <Section title="9. Serverseitiges Caching und Datenbanken">
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
      <Section title="10. E-Mail-Kommunikation">
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
      <Section title="11. Ihre Rechte nach der DSGVO">
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
      <Section title="12. Datenspeicherung">
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
              <strong>Mangrove-Schl&uuml;sselpaar</strong> &mdash; wird aufbewahrt, bis Sie es neu
              generieren oder Ihr Konto l&ouml;schen. Das L&ouml;schen des Schl&uuml;sselpaars auf
              unseren Servern <strong>widerruft nicht</strong> bereits ver&ouml;ffentlichte
              Bewertungen aus dem Mangrove-Netzwerk.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Ver&ouml;ffentlichte Bewertungsinhalte</strong> &mdash; verbleiben im
              Mangrove-Netzwerk und seinen Spiegeln au&szlig;erhalb unserer Kontrolle. Innerhalb der
              Anzeige von OpenMapX k&ouml;nnen Bewertungen auf Wunsch ausgeblendet werden; bei
              externen Aggregatoren richtet sich die Aufbewahrung nach deren jeweiligen Richtlinien.
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
      <Section title="13. Sicherheit">
        <Typography>
          Wir setzen angemessene technische und organisatorische Ma&szlig;nahmen zum Schutz Ihrer
          Daten ein, darunter verschl&uuml;sselte Verbindungen (TLS/HTTPS), gehashte Passw&ouml;rter
          (mit modernen Schl&uuml;sselableitungsfunktionen), sichere Sitzungsverwaltung und
          parametrisierte Datenbankabfragen. Jedoch ist keine Methode der &Uuml;bertragung &uuml;ber
          das Internet zu 100&nbsp;% sicher.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          <strong>
            Vertrauensmodell f&uuml;r das Mangrove-Schl&uuml;sselpaar (Abschnitt&nbsp;5).
          </strong>{" "}
          Im Passphrase-Modus sowie im kombinierten Passphrase- und Passkey-Modus verl&auml;sst der
          private Signaturschl&uuml;ssel Ihren Browser niemals im Klartext. Selbst eine
          vollst&auml;ndige Kompromittierung unserer Datenbank w&uuml;rde nur
          age-verschl&uuml;sseltes Chiffrat offenlegen, das ohne Ihre Passphrase oder einen
          registrierten Passkey nicht entschl&uuml;sselt werden kann. Im
          &bdquo;unverschl&uuml;sselten Opt-in-Modus&ldquo; hingegen wird der private Schl&uuml;ssel
          im Klartext gespeichert; Personen mit Datenbankzugriff k&ouml;nnten daher Bewertungen in
          Ihrem Namen signieren. Wir empfehlen, einen der verschl&uuml;sselten Modi zu w&auml;hlen
          und Ihre Passphrase niemals weiterzugeben.
        </Typography>
      </Section>
      <Section title="14. Datenschutz von Kindern">
        <Typography>
          OpenMapX richtet sich nicht an Kinder unter 16&nbsp;Jahren. Wir erheben wissentlich keine
          personenbezogenen Daten von Kindern. Wenn Sie glauben, dass ein Kind uns personenbezogene
          Daten &uuml;bermittelt hat, kontaktieren Sie uns bitte, damit wir diese l&ouml;schen
          k&ouml;nnen.
        </Typography>
      </Section>
      <Section title="15. &Auml;nderungen dieser Erkl&auml;rung">
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
  endUserExposure?: string;
}

function ServiceTable({ rows }: { rows: ServiceRow[] }) {
  const hasExposure = rows.some((r) => r.endUserExposure);
  return (
    <TableContainer sx={{ mt: 1, mb: 1 }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 600 }}>Dienst</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Zweck</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>&Uuml;bermittelte Daten</TableCell>
            {hasExposure && <TableCell sx={{ fontWeight: 600 }}>Datenzugriff</TableCell>}
            <TableCell sx={{ fontWeight: 600 }}>Land</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Datenschutzinfo</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={`${row.service}-${row.country}-${row.purpose}-${row.dataSent}-${row.privacy}`}
            >
              <TableCell>{row.service}</TableCell>
              <TableCell>{row.purpose}</TableCell>
              <TableCell>{row.dataSent}</TableCell>
              {hasExposure && <TableCell>{row.endUserExposure}</TableCell>}
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
