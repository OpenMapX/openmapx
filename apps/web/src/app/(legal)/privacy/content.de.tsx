import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import type { Disclosure, PublicLegalConfig } from "@openmapx/core/server";
import { legalConfig, sectionSlug } from "@openmapx/core/server";
import { emailCountryName, emailTransferNote } from "../emailDisclosure";
import { generatePrivacySectionsFromManifests } from "../generateLegalSections";
import { privacyTitles } from "./sections";

export default function PrivacyContentDe({
  capabilities: _capabilities = {},
  integrations = [],
  disclosures = [],
  legal,
}: {
  capabilities?: Record<string, boolean>;
  integrations?: import("@openmapx/integration-framework").LoadedIntegrationMeta[];
  disclosures?: Disclosure[];
  legal?: PublicLegalConfig;
}) {
  const {
    name,
    street,
    postalCode,
    city,
    country,
    email,
    supervisoryAuthority: supervisoryAuthorityEnv,
    supervisoryAuthorityUrl: supervisoryAuthorityUrlEnv,
    hostingProvider: hostingProviderEnv,
    hostingLocations: hostingLocationsEnv,
    serverLogRetentionDays: serverLogRetentionDaysEnv,
  } = legalConfig;
  // Hosting-Anbieter/Standorte, Aufsichtsbehörde und Log-Aufbewahrung werden in
  // app-api als env > Admin-Datenbank > Default aufgelöst und kommen über
  // `legal`. Fallback auf die Web-Prozess-Env (legalConfig) nur, wenn die API
  // beim SSR nicht erreichbar ist.
  const hostingProvider = legal?.hostingProvider || hostingProviderEnv;
  const hostingLocations = legal?.hostingLocations || hostingLocationsEnv;
  const supervisoryAuthority = legal?.supervisoryAuthority || supervisoryAuthorityEnv;
  const supervisoryAuthorityUrl = legal?.supervisoryAuthorityUrl || supervisoryAuthorityUrlEnv;
  const serverLogRetentionDays = legal?.serverLogRetentionDays ?? serverLogRetentionDaysEnv;
  const T = privacyTitles("de");

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
        Zuletzt aktualisiert: 10. August 2026
      </Typography>
      <Section title={T.controller}>
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
        <Typography sx={{ mt: 1 }}>
          Ein Datenschutzbeauftragter ist gesetzlich nicht erforderlich und wurde daher nicht
          bestellt. F&uuml;r alle Datenschutzanliegen erreichen Sie uns unter der oben genannten
          E-Mail-Adresse.
        </Typography>
      </Section>
      <Section title={T.overview}>
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
              Ver&ouml;ffentlichung der von Ihnen verfassten Korrekturen bei OpenStreetMap, sofern
              Sie die Beitragsfunktion nutzen (siehe Abschnitt&nbsp;7)
            </Typography>
          </li>
          <li>
            <Typography>
              Optionale, schreibgesch&uuml;tzte Anzeige pers&ouml;nlicher Standortverl&auml;ufe aus
              einer von Ihnen verbundenen Dawarich-Instanz
            </Typography>
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
      <Section title={T.hosting}>
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
          Dienstes). Server-Protokolle werden nach {serverLogRetentionDays}&nbsp;Tagen automatisch
          gel&ouml;scht.
        </Typography>
        {hostingProvider && (
          <Typography sx={{ mt: 1 }}>
            Unsere Server werden von {hostingProvider} betrieben. Der Anbieter verarbeitet Daten in
            unserem Auftrag und ausschlie&szlig;lich nach unserer Weisung (Auftragsverarbeiter
            gem&auml;&szlig; Art.&nbsp;28 DSGVO). Ein Auftragsverarbeitungsvertrag liegt vor.
            {hostingLocations ? ` Die Rechenzentren befinden sich in ${hostingLocations}.` : ""}
          </Typography>
        )}
      </Section>
      <Section title={T.geolocation}>
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
        <Typography sx={{ mt: 1 }}>
          Wenn Sie unabh&auml;ngig davon den pers&ouml;nlichen Zeitstrahl aktivieren, werden
          historische Besuche, Wege, Begrenzungen und Routengeometrien aus Ihrem Dawarich-Konto
          verarbeitet, um den von Ihnen gew&auml;hlten Tag anzuzeigen. Dies ist von der
          Live-Standortberechtigung des Browsers getrennt und kann vergangene Orte und
          Bewegungsmuster erkennen lassen.
        </Typography>
      </Section>
      <Section title={T.accounts}>
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
          Die von diesen Anbietern ausgestellten Access- und Refresh-Token werden mit dem
          Authentifizierungsgeheimnis dieser Installation verschl&uuml;sselt gespeichert und bei
          Bedarf erneuert, bis Sie die Verkn&uuml;pfung aufheben oder Ihr Konto l&ouml;schen. Sie
          werden nie an Ihren Browser gesendet. Wenn Sie die OpenStreetMap-Beitragsfunktion nutzen,
          kann das verkn&uuml;pfte OpenStreetMap-Konto zus&auml;tzlich Schreibberechtigungen halten
          &mdash; siehe Abschnitt&nbsp;7.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          <strong>Pers&ouml;nlicher Zeitstrahl (optional).</strong> Bei ausdr&uuml;cklicher
          Aktivierung w&auml;hlen Sie entweder eine externe Dawarich-Instanz oder den von diesem
          OpenMapX-Betreiber verwalteten Dawarich-Dienst. Wir speichern den &ouml;ffentlichen
          Ursprung der Instanz, sichere Verbindungsmetadaten und Ihren Dawarich-API-Schl&uuml;ssel;
          der API-Schl&uuml;ssel wird im Ruhezustand verschl&uuml;sselt. F&uuml;r jeden
          angeforderten Tag verarbeitet unser Backend vor&uuml;bergehend Datum, Zeitzone, Besuche,
          Wege, Begrenzungen und Routengeometrien und leitet die Anfrage an Dawarich weiter.
          OpenMapX speichert diesen abgerufenen Verlauf nicht dauerhaft, legt ihn weder in gemeinsam
          genutzten noch browserpersistenten Cache ab und verwendet ihn nicht f&uuml;r Analysen.
          Beim Trennen der Verbindung oder L&ouml;schen Ihres OpenMapX-Kontos werden die
          OpenMapX-Verbindung und der verschl&uuml;sselte Zugang gel&ouml;scht.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Der Betreiber einer von Ihnen gew&auml;hlten externen Dawarich-Instanz bleibt unter dessen
          Bedingungen ein eigener Verantwortlicher oder Auftragsverarbeiter und kann Anfragen vom
          OpenMapX-Server erhalten. Bei verwaltetem Dawarich wird die Instanz von diesem
          OpenMapX-Betreiber gehostet. Browser-SSO &uuml;bermittelt Ihre stabile Kontokennung (
          <code>sub</code>), Ihren Namen und Ihre E-Mail-Adresse an das verwaltete Dawarich; der
          getrennt bereitgestellte API-Schl&uuml;ssel autorisiert den schreibgesch&uuml;tzten
          Verlaufszugriff. Dawarich bewahrt eigene Konto- und Verlaufsdaten nach den Einstellungen
          und Aufbewahrungsregeln des Instanzbetreibers auf. Zugriffs-, Berichtigungs-, L&ouml;sch-
          und API-Schl&uuml;ssel-Funktionen von Dawarich &uuml;ben Sie direkt in den
          Kontoeinstellungen dieser Instanz aus.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Die Funktion wird von Ihnen initiiert und kann jederzeit getrennt werden. Vor der Freigabe
          der optionalen Funktion muss die Projektverantwortung die f&uuml;r die konkrete
          Bereitstellung geltende Rechtsgrundlage und etwaige Einwilligungstexte best&auml;tigen;
          diese Implementierung trifft diese rechtliche Bewertung nicht.
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
      <Section title={T.reviews}>
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
          dezentralen Designs des Systems nicht einseitig zur&uuml;ckgezogen werden. Soweit Ihre
          Bewertung dabei an Aggregatoren in L&auml;ndern au&szlig;erhalb des Europ&auml;ischen
          Wirtschaftsraums (EWR) &uuml;bermittelt wird, beruht diese &Uuml;bermittlung auf Ihrer
          ausdr&uuml;cklichen Einwilligung gem&auml;&szlig; Art.&nbsp;49 Abs.&nbsp;1 lit.&nbsp;a
          DSGVO.
        </Typography>
      </Section>
      <Section title={T.osmContributions}>
        <Typography>
          Wenn Ihre Instanz Beitr&auml;ge aktiviert hat, k&ouml;nnen Sie aus OpenMapX heraus einige
          wenige Angaben zu einem bereits vorhandenen{" "}
          <Link href="https://www.openstreetmap.org/" target="_blank" rel="noopener noreferrer">
            OpenStreetMap
          </Link>
          -Ort korrigieren oder einen &ouml;ffentlichen OpenStreetMap-Hinweis hinterlassen. Das ist
          freiwillig: Sie m&uuml;ssen die Funktion nicht nutzen, und dieser Abschnitt gilt nur, wenn
          Sie es tun.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Wie bei Bewertungen wird dabei etwas au&szlig;erhalb unserer Server ver&ouml;ffentlicht,
          das wir nicht mehr r&uuml;ckg&auml;ngig machen k&ouml;nnen. Bitte lesen Sie diesen
          Abschnitt daher vor dem Ver&ouml;ffentlichen.
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Zus&auml;tzliche OpenStreetMap-Berechtigungen.</strong> Die normale Anmeldung
              fragt nur die minimalen Berechtigungen <code>openid read_prefs</code> ab. Beim ersten
              Beitrag werden Sie zu OpenStreetMap weitergeleitet, um <code>write_api</code>{" "}
              (f&uuml;r Bearbeitungen) oder <code>write_notes</code> (f&uuml;r Hinweise) zu
              erteilen. Sie k&ouml;nnen diese Berechtigungen jederzeit in Ihren
              OpenStreetMap-Kontoeinstellungen widerrufen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Anbieter-Token.</strong> Die von OpenStreetMap ausgestellten Access- und
              Refresh-Token werden auf unserem Server gespeichert, dabei mit dem
              Authentifizierungsgeheimnis dieser Installation verschl&uuml;sselt und bei Bedarf
              erneuert, bis Sie die Verkn&uuml;pfung aufheben oder Ihr Konto l&ouml;schen. Token
              werden nie an Ihren Browser gesendet und erscheinen nicht in unseren Protokollen,
              Metriken oder Fehlermeldungen. Token, die vor Einf&uuml;hrung der Verschl&uuml;sselung
              gespeichert wurden, bleiben lesbar und werden bei der n&auml;chsten Aktualisierung neu
              verschl&uuml;sselt; im seltenen Fall, dass ein solcher Altwert nicht mehr lesbar ist,
              werden Sie lediglich gebeten, das Konto erneut zu verkn&uuml;pfen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Anfragen in Ihrem Namen.</strong> Wenn Sie den Editor &ouml;ffnen, ruft unser
              Server &mdash; nicht Ihr Browser &mdash; OpenStreetMap auf, um das aktuelle Objekt,
              Ihre Kontodaten und Ihre Berechtigungen zu lesen und beim Ver&ouml;ffentlichen den
              &Auml;nderungssatz anzulegen und das Objekt zu aktualisieren. OpenStreetMap sieht
              dabei die IP-Adresse unseres Servers, nicht Ihre. Nur beim Autorisierungsschritt wird
              Ihr Browser direkt zu OpenStreetMap weitergeleitet; dabei kann OpenStreetMap Ihre
              IP-Adresse und Browser-Anfragedaten erhalten.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Was an OpenStreetMap &uuml;bermittelt wird.</strong> Bei einer Bearbeitung:
              die Objektreferenz, die ge&auml;nderten Tags, der von Ihnen verfasste Kommentar zum
              &Auml;nderungssatz, die von Ihnen gew&auml;hlte Quelle, Ihre Oberfl&auml;chensprache
              als <code>locale</code>-Tag, ein <code>created_by</code>-Tag mit OpenMapX und dessen
              Version sowie optional die Bitte um Gegenpr&uuml;fung. Bei einem Hinweis: Ihr Text und
              die Koordinaten, die unser Server aus dem Objekt selbst berechnet. Werte aus unseren
              Anreicherungsdiensten werden niemals als Ihre Quelle hochgeladen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>
                Der Beitrag ist &ouml;ffentlich und mit Ihrer OpenStreetMap-Identit&auml;t
                verkn&uuml;pft.
              </strong>{" "}
              Ihre Bearbeitung oder Ihr Hinweis wird unter Ihrem verkn&uuml;pften
              OpenStreetMap-Konto ver&ouml;ffentlicht. Ihr OpenStreetMap-Benutzername, der
              &Auml;nderungssatz, Ihr Kommentar, Ihre Quellenangabe, die resultierenden Tags, der
              Hinweistext und Ihr Bearbeitungsverlauf werden Teil der &ouml;ffentlichen Datenbank
              und Historie von OpenStreetMap. Diese Datenbank wird von der OpenStreetMap Foundation
              betrieben und unterliegt deren eigener{" "}
              <Link
                href="https://osmfoundation.org/wiki/Privacy_Policy"
                target="_blank"
                rel="noopener noreferrer"
              >
                Datenschutzerkl&auml;rung
              </Link>{" "}
              und den{" "}
              <Link
                href="https://osmfoundation.org/wiki/Licence/Contributor_Terms"
                target="_blank"
                rel="noopener noreferrer"
              >
                Mitwirkendenbedingungen
              </Link>
              , die Sie vor dem Bearbeiten annehmen m&uuml;ssen &mdash; nicht unseren.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>
                Das L&ouml;schen Ihres OpenMapX-Kontos l&ouml;scht Ihre OpenStreetMap-Historie
                nicht.
              </strong>{" "}
              Beim L&ouml;schen Ihres Kontos hier werden die gespeicherten Anbieter-Token und die
              Verkn&uuml;pfung zu Ihrem OpenStreetMap-Konto entfernt. Auf bereits bei OpenStreetMap
              ver&ouml;ffentlichte Beitr&auml;ge hat das keine Auswirkung; sie sind Teil einer
              &ouml;ffentlichen, dauerhaft versionierten Datenbank und liegen au&szlig;erhalb
              unseres Einflussbereichs. Anliegen dazu richten Sie bitte an die OpenStreetMap
              Foundation.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Kurzlebige Betriebsdaten.</strong> Damit ein Doppelklick nicht zweimal
              ver&ouml;ffentlicht, speichern wir kurzzeitig eine Sperre und das Ergebnis des
              Vorgangs. Die Schl&uuml;ssel sind Einweg-HMAC-Digests aus Ihrer Benutzer-ID, der
              Objektreferenz und einer zuf&auml;lligen Vorgangs-ID; die gespeicherten Werte
              enthalten nur &ouml;ffentliche Ergebniskennungen (&Auml;nderungssatz- oder
              Hinweis-ID), die zugeh&ouml;rigen Links und einen Zeitstempel. Sperren verfallen nach
              zwei Minuten, erfolgreiche Ergebnisse nach 24 Stunden, ein ungekl&auml;rtes Ergebnis
              nach zwei Minuten. Die Ratenbegrenzung f&uuml;hrt einen &auml;hnlichen kurzlebigen,
              digest-basierten Z&auml;hler. Eine Datenbank mit Beitragsinhalten f&uuml;hren wir
              nicht: weder Tags noch Kommentare, Hinweistexte oder Quellen werden hier gespeichert.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Protokolle und Metriken sind inhaltsfrei.</strong> Die Betriebstelemetrie
              erfasst nur, welche Art von Vorgang ausgef&uuml;hrt wurde, ob er erfolgreich war, wie
              lange er gedauert hat und eine zuf&auml;llige Anfrage-ID. Objekte, Tags, Namen,
              Koordinaten, Kommentare, Hinweistexte, Quellen, Kontonamen oder Token werden nicht
              erfasst. F&uuml;r Server-Protokolle gilt die &uuml;bliche Speicherdauer aus
              Abschnitt&nbsp;13.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Rechtsgrundlage f&uuml;r das Speichern und Erneuern der OpenStreetMap-Token ist
          Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;b DSGVO (Erf&uuml;llung des von Ihnen angeforderten
          Beitragsdienstes). Rechtsgrundlage f&uuml;r die Ver&ouml;ffentlichung Ihres Beitrags bei
          OpenStreetMap ist Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;a DSGVO (Ihre ausdr&uuml;ckliche
          Einwilligung, erteilt, indem Sie eine Quelle w&auml;hlen, einen eigenen Kommentar
          verfassen und &bdquo;In OpenStreetMap ver&ouml;ffentlichen&ldquo; ausl&ouml;sen, nachdem
          Ihnen genau angezeigt wurde, was &uuml;bermittelt wird und dass es &ouml;ffentlich ist).
          Sie k&ouml;nnen die Einwilligung f&uuml;r die Zukunft jederzeit widerrufen, indem Sie
          keine weiteren Beitr&auml;ge ver&ouml;ffentlichen und die Berechtigungen in Ihrem
          OpenStreetMap-Konto entziehen; bereits ver&ouml;ffentlichte Beitr&auml;ge k&ouml;nnen
          nicht einseitig zur&uuml;ckgenommen werden, da OpenStreetMap eine &ouml;ffentliche
          Datenbank mit dauerhafter Bearbeitungshistorie ist. Soweit Ihr Beitrag dadurch an
          Empf&auml;nger au&szlig;erhalb des Europ&auml;ischen Wirtschaftsraums (EWR)
          &uuml;bermittelt wird, st&uuml;tzt sich diese &Uuml;bermittlung auf Ihre
          ausdr&uuml;ckliche Einwilligung nach Art.&nbsp;49 Abs.&nbsp;1 lit.&nbsp;a DSGVO.
        </Typography>
      </Section>
      <Section title={T.thirdParty}>
        <Typography>
          Um seine Kartenfunktionen bereitzustellen, sendet OpenMapX Anfragen an verschiedene
          Drittanbieter-APIs. Wenn Sie eine Funktion nutzen, werden bestimmte Daten (typischerweise
          Kartenausschnitt-Koordinaten, Suchanfragen oder Routenwegpunkte) an den jeweiligen
          Anbieter &uuml;bermittelt. Unser Backend-Server fungiert f&uuml;r die meisten dieser
          Anfragen als Proxy, sodass Drittanbieter in der Regel die IP-Adresse unseres Servers und
          nicht Ihre Browser-IP-Adresse sehen. Nachfolgend eine vollst&auml;ndige Liste aller
          externen Dienste:
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Ein von Benutzern gew&auml;hlter Dawarich-Ursprung ist in den nachfolgend generierten
          Anbietertabellen nicht enthalten, weil Betreiber und Standort vom Benutzer gew&auml;hlt
          werden. Verwaltetes Dawarich ist ein optionaler First-Party-Dienst dieser Bereitstellung
          und kein Integrationsanbieter. In beiden Modi leitet OpenMapX Anfragen zum
          pers&ouml;nlichen Zeitstrahl wie in Abschnitt&nbsp;5 beschrieben weiter.
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
              purpose: "Anmeldung \u00fcber OSM-Konto; optionale Beitragsberechtigungen",
              dataSent:
                "Browser-Weiterleitung zur OSM-Autorisierungsseite; OAuth-Autorisierungsablauf (kein Passwort wird an uns weitergegeben)",
              endUserExposure: "Direkt (Browser)",
              country: "UK",
              privacy: "https://osmfoundation.org/wiki/Privacy_Policy",
            },
            {
              service: "OpenStreetMap-API (Beitr\u00e4ge)",
              purpose:
                "Lesen des aktuellen Objekts und Ver\u00f6ffentlichen Ihrer Bearbeitung oder Ihres Hinweises, sofern Sie die Beitragsfunktion nutzen (Abschnitt 7)",
              dataSent:
                "Serverseitig: Objektreferenz, Ihre ge\u00e4nderten Tags, Ihr Kommentar zum \u00c4nderungssatz und Ihre Quellenangabe, Sprache, created_by; oder Ihr Hinweistext und eine serverseitig berechnete Position. Die Ver\u00f6ffentlichung erfolgt \u00f6ffentlich unter Ihrem verkn\u00fcpften OSM-Konto.",
              endUserExposure: "Serverseitig",
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

        {(() => {
          const cloudProcessors = [
            ...new Map(
              disclosures
                .flatMap((d) => (d.type === "ai-search" && d.cloudActive ? d.cloudProcessors : []))
                .map((processor) => [processor.id, processor]),
            ).values(),
          ];
          if (cloudProcessors.length === 0) return null;
          return (
            <>
              <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
                KI-Anfrageinterpretation (Cloud)
              </Typography>
              <ServiceTable
                rows={cloudProcessors.map((processor) => ({
                  service: processor.name,
                  purpose:
                    "Interpretation Ihrer natürlichsprachlichen Suchanfrage in eine strukturierte Suche",
                  dataSent:
                    "Ihr Suchanfragetext und ungefährer Kartenmittelpunkt (gerundete Koordinaten)",
                  endUserExposure: "Nur serverseitig",
                  country: processor.countryCode,
                  privacy: processor.privacyUrl,
                }))}
              />
              <Typography variant="body2" sx={{ mt: 1 }}>
                Soweit die Verarbeitung au&szlig;erhalb des EWR stattfindet, erfolgt die
                &Uuml;bermittlung auf Grundlage der vom konfigurierten Auftragsverarbeiter
                angegebenen Garantien, etwa eines Angemessenheitsbeschlusses oder der
                EU-Standardvertragsklauseln (Art.&nbsp;46 Abs.&nbsp;2 lit.&nbsp;c DSGVO).
              </Typography>
            </>
          );
        })()}

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          Sprachsuche (Mikrofon)
        </Typography>
        <Typography>
          Die Suchleiste bietet optional eine Spracheingabe. Sie ist erst aktiv, wenn Sie die
          Schaltfläche drücken. Danach fragt Ihr Browser die Mikrofonberechtigung ab und wandelt
          Ihre Spracheingabe mit der browsereigenen Spracherkennung (Web Speech API) in Suchtext um.
          An unsere Server gelangt ausschließlich der resultierende Text als gewöhnliche Suchanfrage
          — die Audiodaten erhalten und speichern wir nicht.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Wo die Spracherkennung stattfindet, entscheidet Ihr Browser, nicht OpenMapX.
          Chromium-basierte Browser (Chrome, Edge und die meisten Abkömmlinge) übertragen die
          aufgenommenen Audiodaten zur Transkription an den Cloud-Sprachdienst ihres Herstellers,
          für den dessen eigene Datenschutzerklärung gilt; andere Browser erkennen die Sprache
          gegebenenfalls lokal auf Ihrem Gerät oder bieten die Funktion nicht an — dann wird die
          Schaltfläche nicht angezeigt. Wenn Sie eine Verarbeitung durch Ihren Browserhersteller
          nicht wünschen, nutzen Sie die Sprachschaltfläche nicht; die Eingabe über die Tastatur
          verwendet kein Mikrofon.
        </Typography>

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
              <strong>Direkte Browser-Verbindungen zu Medienanbietern:</strong> Einige Webcam-Video-
              oder Player-Anbieter k&ouml;nnen Ihre IP-Adresse und Browser-/Ger&auml;te-Anfragedaten
              erhalten, wenn Sie &quot;Medien laden&quot; anklicken oder Live-Medien anderweitig
              &ouml;ffnen. Abdeckung, Metadaten und Bilddateien der Stra&szlig;enansicht werden
              &uuml;ber unseren API-Proxy geleitet.
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
      <Section title={T.cookies}>
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
              Ressourcen (HTML, CSS, JavaScript), Online-Kartenkacheln und versionierte
              Glyphen-Ressourcen f&uuml;r Offline-Pakete &uuml;ber die Cache-Storage-API des
              Browsers zwischen. Offline-Kartenarchive werden in IndexedDB oder im Origin Private
              File System gespeichert und vor der Verwendung verifiziert. Dies erm&ouml;glicht
              Offline-Funktionalit&auml;t und schnelleres Laden. Zwischengespeicherte Eintr&auml;ge
              laufen automatisch ab (statische Ressourcen: 30&nbsp;Tage; Online-Kartenkacheln:
              3&ndash;7&nbsp;Tage). Laufzeit-Caches f&uuml;r API-Antworten zu Suche, Routen, Orten,
              Autovervollst&auml;ndigung, Wetter und Foto-Lookups werden nur geschrieben, wenn Sie
              den Cache f&uuml;r k&uuml;rzliche Kartendaten aktivieren.
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
      <Section title={T.caching}>
        <Typography>
          Um die Leistung zu verbessern und die Last auf Drittanbieter-APIs zu reduzieren, speichert
          unser Server API-Antworten in Redis (einem In-Memory-Datenspeicher) zwischen.
          Zwischengespeicherte Daten umfassen typischerweise Kartensuchergebnisse, Fahrpl&auml;ne,
          Routenantworten und Katalogdaten externer Verzeichnisse. Cache-Eintr&auml;ge laufen
          automatisch ab (in der Regel innerhalb von Minuten bis 48&nbsp;Stunden). Der Cache
          speichert keine personenbezogenen Daten wie IP-Adressen oder Kontoinformationen.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Antworten des pers&ouml;nlichen Zeitstrahls sind ausdr&uuml;cklich von Redis-,
          Service-Worker-, persistenten Abfrage- und Browser-Speicher-Caches ausgeschlossen. Nur ein
          nicht benutzerbezogenes Ergebnis der Zustandspr&uuml;fung des verwalteten Dienstes darf
          h&ouml;chstens 15&nbsp;Sekunden im Serverspeicher gehalten werden; es enth&auml;lt weder
          Zeitstrahl-, Konto-, Zugangs-, Hostnamen- noch Anfragedatumsdaten.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Wir betreiben au&szlig;erdem eine PostgreSQL-Datenbank f&uuml;r Benutzerkonten,
          gespeicherte Orte und gecachte Ortsanreicherungsdaten (z.&nbsp;B. Wikidata-Fakten,
          Wikipedia-Zusammenfassungen). Wenn GTFS-Nahverkehrs-Feeds importiert werden, werden
          Fahrplandaten (Haltestellennamen, Linien, Abfahrtszeiten) in separaten Datenbank-Schemas
          gespeichert. Diese Daten stellen keine personenbezogenen Daten von Endnutzern dar.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Wenn Sie die OpenStreetMap-Beitragsfunktion nutzen, werden kurzzeitig eine Sperre und ein
          Ergebnisdatensatz vorgehalten (in Redis, sofern konfiguriert, sonst im Arbeitsspeicher),
          ausschlie&szlig;lich um eine doppelte Einreichung zu verhindern. Deren Schl&uuml;ssel sind
          Einweg-Digests, deren Werte enthalten nur &ouml;ffentliche Ergebniskennungen und
          Zeitstempel &mdash; niemals Beitragsinhalte. Siehe Abschnitt&nbsp;7.
        </Typography>
      </Section>
      <Section title={T.email}>
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
        {(() => {
          const email = disclosures.find((d) => d.type === "email");
          const country = email ? emailCountryName(email.countryCode, "de") : "";
          const transferNote = email ? emailTransferNote(email.transfer, "de") : "";
          return (
            <Typography sx={{ mt: 1 }}>
              {email?.vendorName ? (
                <>
                  Diese E-Mails werden &uuml;ber {email.vendorName}
                  {country ? ` (${country})` : ""} versendet &mdash; einen Dienstleister, der in
                  unserem Auftrag und nach unserer Weisung t&auml;tig wird (Auftragsverarbeiter
                  gem&auml;&szlig; Art.&nbsp;28 DSGVO)
                  {email.privacyUrl ? (
                    <>
                      {" "}
                      <Link href={email.privacyUrl} target="_blank" rel="noopener noreferrer">
                        (Datenschutzhinweise)
                      </Link>
                    </>
                  ) : null}
                  .{transferNote ? ` ${transferNote}` : ""}{" "}
                </>
              ) : (
                <>
                  Diese E-Mails werden &uuml;ber einen von uns betriebenen bzw. beauftragten
                  SMTP-Server versendet.{" "}
                </>
              )}
              Sie enthalten nur die f&uuml;r die jeweilige Aktion notwendigen Informationen. Wir
              versenden keine Newsletter oder Marketing-E-Mails. Rechtsgrundlage ist Art.&nbsp;6
              Abs.&nbsp;1 lit.&nbsp;b DSGVO (Vertragserf&uuml;llung / Bereitstellung des von Ihnen
              angeforderten Dienstes).
            </Typography>
          );
        })()}
      </Section>
      <Section title={T.rights}>
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
          Aufsichtsbeh&ouml;rde einzulegen (Art.&nbsp;77 DSGVO).
          {supervisoryAuthority && (
            <>
              {" "}
              Zust&auml;ndige Aufsichtsbeh&ouml;rde ist: {supervisoryAuthority}
              {supervisoryAuthorityUrl && (
                <>
                  ,{" "}
                  <Link href={supervisoryAuthorityUrl} target="_blank" rel="noopener noreferrer">
                    {supervisoryAuthorityUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")}
                  </Link>
                </>
              )}
              .
            </>
          )}
        </Typography>
        <Typography sx={{ mt: 1 }}>
          <strong>Keine automatisierte Entscheidungsfindung.</strong> Wir nutzen Ihre
          personenbezogenen Daten nicht f&uuml;r eine automatisierte Entscheidungsfindung
          einschlie&szlig;lich Profiling im Sinne des Art.&nbsp;22 DSGVO.
        </Typography>
      </Section>
      <Section title={T.retention}>
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
              <strong>Verbindung zum pers&ouml;nlichen Zeitstrahl</strong> &mdash; der
              verschl&uuml;sselte API-Schl&uuml;ssel und sichere Verbindungsmetadaten werden bis zur
              Trennung oder L&ouml;schung Ihres OpenMapX-Kontos aufbewahrt. Abgerufene Verl&auml;ufe
              werden von OpenMapX nicht aufbewahrt. Das Deaktivieren des verwalteten Dawarich
              erh&auml;lt dessen getrennte Dienst-Volumes; Aufbewahrung und L&ouml;schung des
              Dawarich-Kontos und -Verlaufs richten sich nach dem Instanzbetreiber und den direkten
              Dawarich-Kontoeinstellungen.
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
              <strong>OpenStreetMap-Anbieter-Token</strong> &mdash; werden (verschl&uuml;sselt)
              aufbewahrt, bis Sie die Verkn&uuml;pfung aufheben oder Ihr Konto l&ouml;schen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Ver&ouml;ffentlichte OpenStreetMap-Beitr&auml;ge</strong> &mdash; sind Teil
              der &ouml;ffentlichen Datenbank und der dauerhaften Bearbeitungshistorie von
              OpenStreetMap und liegen au&szlig;erhalb unserer Kontrolle. Das L&ouml;schen Ihres
              OpenMapX-Kontos entfernt sie nicht.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Betriebsdaten zu Beitr&auml;gen</strong> &mdash; Sperren verfallen nach zwei
              Minuten, erfolgreiche Ergebnisdatens&auml;tze nach 24&nbsp;Stunden; beide enthalten
              keine Beitragsinhalte.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Server-Protokolle</strong> &mdash; werden nach {serverLogRetentionDays}
              &nbsp;Tagen automatisch gel&ouml;scht.
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
      <Section title={T.security}>
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
        <Typography sx={{ mt: 1 }}>
          <strong>OAuth-Anbieter-Token.</strong> Von OpenStreetMap und Mapillary ausgestellte Token
          werden mit dem Authentifizierungsgeheimnis dieser Installation verschl&uuml;sselt
          gespeichert, sodass eine Offenlegung der Datenbank allein keine nutzbaren Token ergibt. Da
          ein OpenStreetMap-Token die Berechtigung enthalten kann, in Ihrem Namen die
          &ouml;ffentliche Karte zu bearbeiten, pr&uuml;ft die Beitragsschnittstelle Ihre
          Berechtigungen zus&auml;tzlich unmittelbar vor jedem Schreibvorgang erneut bei
          OpenStreetMap selbst, statt sich auf den gespeicherten Stand zu verlassen.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Zugangsdaten des pers&ouml;nlichen Zeitstrahls werden vor der Datenbankspeicherung
          verschl&uuml;sselt, aus Antworten, Protokollen, Auditdetails und Metriken ausgeschlossen
          und nur vom Backend &uuml;ber die validierte Verbindung an die gew&auml;hlte Dawarich-API
          gesendet. Der Browser ruft die Dawarich-API niemals direkt auf. Eine verwaltete
          Browser-SSO-Sitzung gew&auml;hrt OpenMapX keinen Verlaufszugriff; der benutzerspezifische
          API-Schl&uuml;ssel bleibt ein getrenntes Zugangsmittel.
        </Typography>
      </Section>
      <Section title={T.children}>
        <Typography>
          OpenMapX richtet sich nicht an Kinder unter 16&nbsp;Jahren. Wir erheben wissentlich keine
          personenbezogenen Daten von Kindern. Wenn Sie glauben, dass ein Kind uns personenbezogene
          Daten &uuml;bermittelt hat, kontaktieren Sie uns bitte, damit wir diese l&ouml;schen
          k&ouml;nnen.
        </Typography>
      </Section>
      <Section title={T.changes}>
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
