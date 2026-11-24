import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import type { Disclosure, IntegrationMetadata } from "@openmapx/core/api-contracts";
import { legalConfig, sectionSlug } from "@openmapx/core/legal";
import type { PublicLegalConfig } from "@openmapx/core/server-api";
import { emailCountryName, emailTransferNote } from "../emailDisclosure";
import { generatePrivacySectionsFromManifests } from "../generateLegalSections";
import { privacyTitles } from "./sections";

export default function PrivacyContentDe({
  integrations = [],
  disclosures = [],
  legal,
}: {
  integrations?: IntegrationMetadata[];
  disclosures?: Disclosure[];
  legal?: PublicLegalConfig | null;
}) {
  const {
    name: nameEnv,
    street: streetEnv,
    postalCode: postalCodeEnv,
    city: cityEnv,
    country: countryEnv,
    email: emailEnv,
    supervisoryAuthority: supervisoryAuthorityEnv,
    supervisoryAuthorityUrl: supervisoryAuthorityUrlEnv,
    hostingProvider: hostingProviderEnv,
    hostingLocations: hostingLocationsEnv,
    serverLogRetentionDays: serverLogRetentionDaysEnv,
  } = legalConfig;
  // Hosting-Anbieter/Standorte, Aufsichtsbehörde und Log-Aufbewahrung werden in
  // der API als env > Admin-Datenbank > Default aufgelöst und kommen über
  // `legal`. Fallback auf die Web-Prozess-Env (legalConfig) nur, wenn die API
  // beim SSR nicht erreichbar ist.
  const name = legal ? legal.name : nameEnv;
  const street = legal ? legal.street : streetEnv;
  const postalCode = legal ? legal.postalCode : postalCodeEnv;
  const city = legal ? legal.city : cityEnv;
  const country = legal ? legal.country : countryEnv;
  const email = legal ? legal.dataRequestEmail : emailEnv;
  const hostingProvider = legal ? legal.hostingProvider : hostingProviderEnv;
  const hostingLocations = legal ? legal.hostingLocations : hostingLocationsEnv;
  const supervisoryAuthority = legal ? legal.supervisoryAuthority : supervisoryAuthorityEnv;
  const supervisoryAuthorityUrl = legal
    ? legal.supervisoryAuthorityUrl
    : supervisoryAuthorityUrlEnv;
  const serverLogRetentionDays = legal ? legal.serverLogRetentionDays : serverLogRetentionDaysEnv;
  // Backup retention is a platform setting only the API reports.
  const backupRetentionDays = legal ? legal.backupRetentionDays : null;
  const auditLogRetentionDays = legal ? legal.auditLogRetentionDays : null;
  const T = privacyTitles("de");

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 1 }}>
        Datenschutzerklärung
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mb: 4,
        }}
      >
        Zuletzt aktualisiert: 25. November 2026
      </Typography>
      <Section title={T.controller}>
        <Typography>
          Der Verantwortliche für die Datenverarbeitung auf dieser Website im Sinne der
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
          bestellt. Für alle Datenschutzanliegen erreichen Sie uns unter der oben genannten
          E-Mail-Adresse.
        </Typography>
      </Section>
      <Section title={T.overview}>
        <Typography>
          OpenMapX ist eine Open-Data-Kartenplattform. Wir sind bestrebt, die Verarbeitung
          personenbezogener Daten auf ein Minimum zu beschränken. Wir verwenden{" "}
          <strong>keine</strong> Analyse-, Tracking- oder Werbedienste. Wir verkaufen oder teilen
          Ihre personenbezogenen Daten nicht zu Marketingzwecken mit Dritten.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Datenverarbeitung erfolgt in folgenden Zusammenhängen:
        </Typography>
        <ul>
          <li>
            <Typography>
              Bereitstellung des Kartendienstes (Kartenkacheln, Suche, Routenplanung, Isochronen,
              Höhenprofile)
            </Typography>
          </li>
          <li>
            <Typography>
              Anzeige von Drittanbieter-Datenebenen (Verkehr, Nahverkehr, Luftqualität,
              Naturkatastrophen, Wanderwege, Straßenansicht, Ortsfotos, Parken, Kraftstoffpreise,
              E-Ladestationen, geteilte Mobilität)
            </Typography>
          </li>
          <li>
            <Typography>Verwaltung von Benutzerkonten (sofern Sie ein Konto erstellen)</Typography>
          </li>
          <li>
            <Typography>
              Veröffentlichung der von Ihnen verfassten Korrekturen bei OpenStreetMap, sofern Sie
              die Beitragsfunktion nutzen (siehe Abschnitt&nbsp;7)
            </Typography>
          </li>
          <li>
            <Typography>
              Weitergabe Ihrer Verkehrs- und Gefahrenmeldungen an OpenConditions, sofern Sie diese
              Funktion nutzen (siehe Abschnitt&nbsp;8)
            </Typography>
          </li>
          <li>
            <Typography>
              Optionale, schreibgeschützte Anzeige persönlicher Standortverläufe aus einer von Ihnen
              verbundenen Dawarich-Instanz
            </Typography>
          </li>
          <li>
            <Typography>
              Clientseitige Speicherung von Einstellungen und gespeicherten Orten auf Ihrem Gerät
            </Typography>
          </li>
          <li>
            <Typography>Serverseitiges Caching zur Leistungsoptimierung</Typography>
          </li>
        </ul>
      </Section>
      <Section title={T.hosting}>
        <Typography>
          Beim Besuch von OpenMapX übermittelt Ihr Browser automatisch bestimmte technische Daten an
          unseren Server. Dazu können gehören:
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
          zu gewährleisten. Rechtsgrundlage ist Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;f DSGVO
          (berechtigtes Interesse an der Bereitstellung eines sicheren und funktionsfähigen
          Dienstes). Gespeicherte OpenMapX-Anwendungsprotokolle werden nach {serverLogRetentionDays}
          &nbsp;Tagen automatisch gelöscht. Reverse-Proxy-, Container- und Hosting-Protokolle
          richten sich nach der separat konfigurierten Infrastruktur-Richtlinie des Betreibers.
        </Typography>
        {hostingProvider && (
          <Typography sx={{ mt: 1 }}>
            Unsere Server werden von {hostingProvider} betrieben. Der Anbieter verarbeitet Daten in
            unserem Auftrag und ausschließlich nach unserer Weisung (Auftragsverarbeiter gemäß
            Art.&nbsp;28 DSGVO). Ein Auftragsverarbeitungsvertrag liegt vor.
            {hostingLocations ? ` Die Rechenzentren befinden sich in ${hostingLocations}.` : ""}
          </Typography>
        )}
      </Section>
      <Section title={T.geolocation}>
        <Typography>
          OpenMapX fordert den Standort Ihres Geräts nur an, wenn Sie ausdrücklich auf die
          Schaltfläche &quot;Mein Standort&quot; klicken. Ihr Browser fragt vor der Weitergabe
          dieser Daten um Erlaubnis. Standortdaten werden:
        </Typography>
        <ul>
          <li>
            <Typography>
              Ausschließlich verwendet, um die Karte auf Ihre Position zu zentrieren
            </Typography>
          </li>
          <li>
            <Typography>Nur in Ihrem Browser verarbeitet (clientseitig)</Typography>
          </li>
          <li>
            <Typography>
              Nicht auf unseren Servern gespeichert und nicht übertragen, es sei denn, Sie nutzen
              aktiv Funktionen, die Koordinaten erfordern (z.&nbsp;B. Routenplanung, Umgebungssuche,
              Nahverkehrsabfahrten)
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Sie können einen Auskunftsantrag in Ihren Kontoeinstellungen starten. Wir stellen eine
          verständliche Erläuterung und, soweit Art.&nbsp;20 DSGVO greift, zusätzlich eine getrennte
          maschinenlesbare Kopie bereit. Das Archiv wird nach einer erneuten Anmeldung beim
          Herunterladen erstellt und direkt an Sie gesendet; wir speichern keine Kopie. Verbundene
          Dawarich-Daten werden, sofern verfügbar, bei diesem verwalteten Dienst angefordert; Daten
          unabhängiger Verantwortlicher, externe Sicherungskopien und reine Browserdaten werden
          gesondert erklärt und nicht stillschweigend als vollständig dargestellt.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Rechtsgrundlage ist Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;a DSGVO (Ihre ausdrückliche
          Einwilligung über die Browser-Berechtigungsabfrage).
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Wenn Sie unabhängig davon den persönlichen Zeitstrahl aktivieren, werden historische
          Besuche, Wege, Begrenzungen und Routengeometrien aus Ihrem Dawarich-Konto verarbeitet, um
          den von Ihnen gewählten Tag anzuzeigen. Dies ist von der Live-Standortberechtigung des
          Browsers getrennt und kann vergangene Orte und Bewegungsmuster erkennen lassen.
        </Typography>
        <Typography variant="subtitle1" sx={{ mt: 3, fontWeight: 600 }}>
          Die installierte mobile App
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Die OpenMapX-App für iOS und Android verhält sich in einem wesentlichen Punkt anders als
          die Website: Während einer von <em>dir gestarteten</em> Navigation nutzt sie deinen
          Standort fortlaufend – auch bei gesperrtem Bildschirm oder wenn die App im Hintergrund
          ist. Nur so kann sie dich weiter führen, wenn das Telefon in der Tasche steckt.
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Nur während einer von dir gestarteten Fahrt.</strong> Eine Route zu planen und
              auf Start zu tippen ist eine bewusste Handlung. Ankunft oder das Beenden der
              Navigation stoppt sie.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Diese Positionen bleiben auf deinem Gerät.</strong> Fortschritt entlang der
              Route, der Zeitpunkt der nächsten Ansage und das Erkennen einer Routenabweichung
              werden auf dem Telefon berechnet.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Koordinaten verlassen das Gerät nur, wenn du eine Route anforderst</strong> –
              bei der Routenanfrage selbst und jeweils einmal, wenn eine Neuberechnung oder eine
              Umplanung nötig wird. Sie werden zur Beantwortung genutzt und nicht gespeichert.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Es gibt keinen Standortverlauf.</strong> Die App hält die aktuelle Sitzung und
              die letzte akzeptierte Position lokal – vom Geräte-Backup ausgenommen –, damit eine
              Fahrt nach einem Absturz oder Neustart fortgesetzt werden kann. Beides wird beim
              Beenden gelöscht und läuft spätestens nach 24 Stunden ab.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>
                Keine Analyse-Tools, keine Werbe-ID, kein Crash-Reporting-SDK und kein Tracking.
              </strong>{" "}
              Die App nutzt auch kein Remote-Push: Der Ausstiegsalarm im öffentlichen Verkehr wird
              lokal von deinem Telefon geplant.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Du kannst den Standort auch nur im Vordergrund erlauben. Die App funktioniert weiterhin
          und sagt dir deutlich, dass die Führung bei gesperrtem Bildschirm pausiert. Du kannst die
          Berechtigung jederzeit in den Systemeinstellungen entziehen und die Navigation jederzeit
          in der App beenden. Ein erzwungenes Beenden der App stoppt die Führung ebenfalls – das
          Betriebssystem startet sie für uns nicht neu.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Für den öffentlichen Verkehr lädt die App die Haltestellenliste jeder gefahrenen
          Teilstrecke einmal vor Fahrtbeginn und zählt die Haltestellen danach auf dem Gerät – so
          weiß sie auch unterirdisch, wann du aussteigen solltest. Ansagen erzeugt die Sprachausgabe
          deines Telefons; nichts wird zum Vorlesen irgendwohin gesendet.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Eine Anmeldung über einen Drittanbieter oder mit einem Passkey öffnet deinen normalen
          Browser statt eines eingebetteten – so siehst du die echte Adressleiste. Die App hält
          deine Sitzung nie selbst; sie erhält einen einmalig verwendbaren Code mit zwei Minuten
          Gültigkeit, der in der App gegen eine Sitzung eingetauscht wird.
        </Typography>
      </Section>
      <Section title={T.accounts}>
        <Typography>
          Sie können OpenMapX ohne Erstellung eines Kontos nutzen. Wenn Sie sich registrieren,
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
              <strong>Passwort</strong> &mdash; wird ausschließlich als kryptografischer Hash
              gespeichert (niemals im Klartext)
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Passkeys (WebAuthn)</strong> &mdash; wenn Sie einen Passkey registrieren, wird
              ein öffentlicher Schlüssel auf unserem Server gespeichert; der private Schlüssel
              verlässt niemals Ihr Gerät. Ein Passkey authentifiziert Sie, verschlüsselt jedoch
              nicht Ihre gespeicherten Orte, Routen, Fahrzeuge, Parkpositionen oder Daten des
              persönlichen Zeitstrahls
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
              <strong>Gespeicherte Orte</strong> &mdash; wenn Sie Orte speichern, während Sie
              angemeldet sind, werden Ortsname, Koordinaten und zugehörige Metadaten in unserer
              Datenbank gespeichert, damit sie geräteübergreifend synchronisiert werden können
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Fahrzeuge und Parkposition</strong> &mdash; wenn Sie ein Fahrzeug anlegen oder
              Ihre Parkposition speichern, während Sie angemeldet sind, werden das Fahrzeugprofil
              sowie die von Ihnen eingegebenen Koordinaten, Adresse, Notiz und Parkzeit in unserer
              Datenbank gespeichert, damit sie geräteübergreifend synchronisiert werden. Nichts wird
              automatisch erfasst; jeder Eintrag stammt von Ihnen. Pro Fahrzeug wird nur die
              aktuelle Parkposition aufbewahrt &mdash; es gibt keinen Parkverlauf
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Mangrove-Bewertungssignaturen</strong> — der primäre Verbindungsweg nutzt den
              gemeinsamen Mangrove-Signierdienst. Mangrove verwahrt den privaten Schlüssel und
              signiert in Ihrem Auftrag. OpenMapX leitet Ihr Signier-Sitzungstoken und den
              Bewertungsinhalt an <code>signer.mangrove.reviews</code> weiter und erhält Ihre
              öffentliche Signaturidentität. Einzelheiten zu Anmeldung und Empfängern stehen in
              Abschnitt&nbsp;6. Alternativ können Sie einen verschlüsselten lokalen
              ECDSA-P-256-Schlüssel wählen. Dabei speichert unser Server den öffentlichen Schlüssel,
              verschlüsseltes privates Schlüsselmaterial und Metadaten der Entsperrmethoden. Eine
              Speicherung privater Schlüssel im Klartext wird nicht unterstützt. Für lokale
              Schlüssel stehen folgende Schutzoptionen zur Verfügung:
            </Typography>
            <ul>
              <li>
                <Typography>
                  <strong>Lokale Passphrase</strong> &mdash; der private Schlüssel wird in Ihrem
                  Browser mit einer von Ihnen gewählten Passphrase verschlüsselt, und zwar mit dem
                  auditierten{" "}
                  <Link
                    href="https://age-encryption.org/v1"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    age-Verschlüsselungsformat
                  </Link>{" "}
                  (scrypt-Schlüsselableitung und ChaCha20-Poly1305). Uns liegt ausschließlich das
                  Chiffrat vor.
                </Typography>
              </li>
              <li>
                <Typography>
                  <strong>Passphrase und/oder WebAuthn-Passkey</strong> &mdash; zusätzlich oder
                  alternativ können Sie den privaten Schlüssel mit einem oder mehreren registrierten
                  Passkeys entsperren (z.&nbsp;B. Biometrie Ihres Geräts,
                  Hardware-Sicherheitsschlüssel). Wir speichern pro Passkey eine
                  age-plugin-fido2prf-Identitätskennung. Diese enthält Credential-ID,
                  Relying-Party-ID und Transporthinweis, jedoch kein geheimes Material.
                </Typography>
              </li>
            </ul>
          </li>
          <li>
            <Typography>
              <strong>Bewertungsinhalte</strong> &mdash; wenn Sie eine Bewertung abgeben, werden die
              von Ihnen bereitgestellten Inhalte (Sternebewertung, Freitext, optionale Bilder,
              optionale Interessenangaben, optionaler Erlebniskontext, Ortsreferenz) vom gemeinsamen
              Mangrove-Signierdienst oder bei gewählter lokaler Signierung in Ihrem Browser
              signiert. Anschließend leitet unser Server die signierte Bewertung an das
              Mangrove.reviews-Netzwerk weiter. Siehe Abschnitt&nbsp;6 zur Veröffentlichung.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Sie können sich auch über OAuth-Drittanbieter anmelden (OpenStreetMap, Mapillary). In
          diesem Fall erhalten wir Ihre öffentlichen Profilinformationen (Name, Profilbild-URL) vom
          jeweiligen Anbieter. Ihr Browser wird während der Autorisierung direkt zum ausgewählten
          Anbieter weitergeleitet; dieser Anbieter kann dabei Ihre IP-Adresse und
          Browser-Anfragedaten erhalten. Wir erhalten oder speichern Ihr Passwort für diese Anbieter
          nicht.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Die von diesen Anbietern ausgestellten Access- und Refresh-Token werden mit dem
          Authentifizierungsgeheimnis dieser Installation verschlüsselt gespeichert und bei Bedarf
          erneuert, bis Sie die Verknüpfung aufheben oder Ihr Konto löschen. Sie werden nie an Ihren
          Browser gesendet. Wenn Sie die OpenStreetMap-Beitragsfunktion nutzen, kann das verknüpfte
          OpenStreetMap-Konto zusätzlich Schreibberechtigungen halten &mdash; siehe
          Abschnitt&nbsp;7.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          <strong>Persönlicher Zeitstrahl (optional).</strong> Bei ausdrücklicher Aktivierung wählen
          Sie entweder eine externe Dawarich-Instanz oder den von diesem OpenMapX-Betreiber
          verwalteten Dawarich-Dienst. Wir speichern den öffentlichen Ursprung der Instanz, sichere
          Verbindungsmetadaten und Ihren Dawarich-API-Schlüssel; der API-Schlüssel wird im
          Ruhezustand verschlüsselt. Für jeden angeforderten Tag verarbeitet unser Backend
          vorübergehend Datum, Zeitzone, Besuche, Wege, Begrenzungen und Routengeometrien und leitet
          die Anfrage an Dawarich weiter. OpenMapX speichert diesen abgerufenen Verlauf nicht
          dauerhaft, legt ihn weder in gemeinsam genutzten noch browserpersistenten Cache ab und
          verwendet ihn nicht für Analysen. Beim Trennen der Verbindung oder Löschen Ihres
          OpenMapX-Kontos werden die OpenMapX-Verbindung und der verschlüsselte Zugang gelöscht.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Der Betreiber einer von Ihnen gewählten externen Dawarich-Instanz bleibt unter dessen
          Bedingungen ein eigener Verantwortlicher oder Auftragsverarbeiter und kann Anfragen vom
          OpenMapX-Server erhalten. Bei verwaltetem Dawarich wird die Instanz von diesem
          OpenMapX-Betreiber gehostet. Browser-SSO übermittelt Ihre stabile Kontokennung (
          <code>sub</code>), Ihren Namen und Ihre E-Mail-Adresse an das verwaltete Dawarich; der
          getrennt bereitgestellte API-Schlüssel autorisiert den schreibgeschützten Verlaufszugriff.
          Dawarich bewahrt eigene Konto- und Verlaufsdaten nach den Einstellungen und
          Aufbewahrungsregeln des Instanzbetreibers auf. Zugriffs-, Berichtigungs-, Lösch- und
          API-Schlüssel-Funktionen von Dawarich üben Sie direkt in den Kontoeinstellungen dieser
          Instanz aus.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Die Funktion wird von Ihnen initiiert und kann jederzeit getrennt werden. Vor der Freigabe
          der optionalen Funktion muss die Projektverantwortung die für die konkrete Bereitstellung
          geltende Rechtsgrundlage und etwaige Einwilligungstexte bestätigen; diese Implementierung
          trifft diese rechtliche Bewertung nicht.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Rechtsgrundlage ist Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;b DSGVO (Vertragserfüllung /
          Bereitstellung des von Ihnen angeforderten Dienstes). Sie können Ihr Konto jederzeit über
          die Kontoeinstellungen löschen.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Die Bereitstellung personenbezogener Daten ist weder gesetzlich noch vertraglich
          vorgeschrieben. Sie können OpenMapX ohne Angabe personenbezogener Daten nutzen. Die
          Erstellung eines Kontos erfordert eine E-Mail-Adresse; ohne diese können kontogebundene
          Funktionen (wie die Synchronisierung gespeicherter Orte) nicht bereitgestellt werden.
        </Typography>
      </Section>
      <Section title={T.reviews}>
        <Typography>
          OpenMapX bindet das dezentrale Bewertungsnetzwerk{" "}
          <Link href="https://mangrove.reviews/" target="_blank" rel="noopener noreferrer">
            Mangrove.reviews
          </Link>{" "}
          (Open Reviews Standard, betrieben von der Open Reviews Association, Zürich, Schweiz) ein.
          Die Nutzung der Bewertungsfunktion hat Auswirkungen, die über unsere eigenen Server
          hinausgehen. Bitte lesen Sie diesen Abschnitt daher sorgfältig, bevor Sie eine Bewertung
          abgeben.
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Gemeinsamer Signierdienst und Anbieter-Anmeldung.</strong> Beim Verbinden wird
              Ihr Browser zu <code>signer.mangrove.reviews</code> und zur gewählten Anmeldung mit
              OpenStreetMap, Bluesky oder Passkey weitergeleitet. Mangrove und der gewählte Anbieter
              können Ihre IP-Adresse, Browser-Anfragedaten und Anmeldeinformationen erhalten. Über
              authentifizierte Schnittstellen übermittelt OpenMapX das Signier-Sitzungstoken und die
              Bewertung an Mangrove und erhält Ihren öffentlichen Schlüssel, die Rezensentenkennung
              und gegebenenfalls Kontodetails oder eine dezentrale Kennung. Mangrove verwahrt den
              privaten Schlüssel und kann für diese Identität signieren; dies ist delegierte
              Schlüsselverwahrung, keine Ende-zu-Ende-Verschlüsselung. Das Token liegt im
              Sitzungsspeicher dieses Tabs, ist an Ihre OpenMapX-Sitzung gebunden und für Skripte
              desselben Ursprungs zugänglich. OpenMapX speichert es nicht in seiner Datenbank.
              Signier-Sitzungen laufen normalerweise nach 24 Stunden ab. Trennen oder Abmelden
              entfernt das lokale Token und versucht einen entfernten Widerruf, der bei einer
              Störung scheitern kann. Verwalten Sie die entfernte Identität bei Mangrove; das
              Löschen Ihres OpenMapX-Kontos löscht diese nicht. Ein Entwurf für das erneute
              Verbinden kann ebenfalls im Tab-Speicher verbleiben; eine Wiederherstellung ist eine
              Stunde lang möglich und übernimmt keine Zustimmung zur Veröffentlichung.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Bewertungen sind öffentlich und dauerhaft.</strong> Wenn Sie eine Bewertung
              abgeben, wird diese mit Ihrem Schlüsselpaar (siehe Abschnitt&nbsp;5) signiert und an{" "}
              <code>api.mangrove.reviews</code> übermittelt. Von dort wird sie von unabhängigen
              Aggregatoren gespiegelt und weiterveröffentlicht, die nicht unserer Kontrolle
              unterliegen. Die Löschung einer Bewertung ist eine Best-Effort-Anfrage an
              Aggregatoren; wir können die Entfernung aus bereits verbreiteten Kopien nicht
              garantieren.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Ihr öffentlicher Schlüssel ist ein dauerhaftes Pseudonym.</strong> Jede von
              Ihnen abgegebene Bewertung wird mit Ihrem öffentlichen Schlüssel signiert und mit ihm
              verknüpft. Der öffentliche Schlüssel wird von Mangrove und den Aggregatoren im
              Klartext gespeichert und bindet alle Ihre Bewertungen sitzungs- und geräteübergreifend
              zu einer pseudonymen Identität zusammen. Jede Person, die eine Verbindung zwischen
              Ihrem öffentlichen Schlüssel und Ihrer realen Identität herstellt, kann alle früheren
              und zukünftigen von Ihnen signierten Bewertungen zuordnen. Der Schlüssel ist kein
              direkter Identifikator (Name, E-Mail usw.), ihn als anonym zu behandeln wäre jedoch
              irreführend.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Was übermittelt wird.</strong> Eine Bewertung enthält: die Subjektkennung (für
              Orte ein <code>geo:</code>-URI mit Koordinaten und Unsicherheitsradius), Ihre
              Sternebewertung, einen optionalen Freitext, optionale Erlebnis-Tags, optionale
              Interessenangaben, optional hochgeladene Bilder, Ihren öffentlichen Schlüssel und Ihre
              Signatur.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Bild-Uploads.</strong> Optionale Bewertungsbilder werden an den Bilddienst von
              Mangrove hochgeladen (<code>files.mangrove.reviews</code>) und sind nach dem Hochladen
              öffentlich abrufbar. Bevor Ihr Bild Ihren Browser verlässt, kodieren wir es über ein
              HTML-Canvas neu und entfernen dabei EXIF-, XMP-, IPTC-, GPS- und ähnliche eingebettete
              Metadaten, die Kameras häufig anhängen. Der sichtbare Bildinhalt selbst bleibt
              erhalten und wird unverändert veröffentlicht.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Abruf von Bewertungen.</strong> Wenn Sie einen Ort in OpenMapX ansehen, ruft
              unser Backend etwaige vorhandene Bewertungen zu diesem Ort von{" "}
              <code>api.mangrove.reviews</code> ab und übermittelt dabei den <code>geo:</code>
              -URI des Orts (Koordinaten). Ihre IP-Adresse wird für Lesevorgänge nicht an Mangrove
              übertragen, da diese über unseren Server laufen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Bearbeiten und Löschen eigener Bewertungen.</strong> Bearbeitungen und
              Löschungen sind selbst signierte Folgebewertungen. Sie werden auf dieselbe Weise wie
              die ursprüngliche Bewertung verbreitet und unterliegen denselben Vorbehalten
              hinsichtlich Spiegelungen und Aufbewahrung durch Dritte.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Rechtsgrundlage für die Speicherung und Signatur Ihres Schlüsselpaars ist Art.&nbsp;6
          Abs.&nbsp;1 lit.&nbsp;b DSGVO (Durchführung des von Ihnen angeforderten
          Bewertungsdienstes). Rechtsgrundlage für die Veröffentlichung der Bewertungsinhalte im
          Mangrove-Netzwerk ist Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;a DSGVO (Ihre ausdrückliche
          Einwilligung, erteilt durch Annahme der in der Bewertungs-Oberfläche eingeblendeten
          Nutzungsbedingungen/Datenschutz-Checkboxen und Bestätigung über
          &bdquo;Veröffentlichen&ldquo;). Sie können eine zukünftige Einwilligung jederzeit
          widerrufen, indem Sie keine weiteren Bewertungen veröffentlichen; bereits veröffentlichte
          Bewertungen können aufgrund des dezentralen Designs des Systems nicht einseitig
          zurückgezogen werden. Soweit Ihre Bewertung dabei an Aggregatoren in Ländern außerhalb des
          Europäischen Wirtschaftsraums (EWR) übermittelt wird, beruht diese Übermittlung auf Ihrer
          ausdrücklichen Einwilligung gemäß Art.&nbsp;49 Abs.&nbsp;1 lit.&nbsp;a DSGVO.
        </Typography>
      </Section>
      <Section title={T.osmContributions}>
        <Typography>
          Wenn Ihre Instanz Beiträge aktiviert hat, können Sie aus OpenMapX heraus einige wenige
          Angaben zu einem bereits vorhandenen{" "}
          <Link href="https://www.openstreetmap.org/" target="_blank" rel="noopener noreferrer">
            OpenStreetMap
          </Link>
          -Ort korrigieren oder einen öffentlichen OpenStreetMap-Hinweis hinterlassen. Das ist
          freiwillig: Sie müssen die Funktion nicht nutzen, und dieser Abschnitt gilt nur, wenn Sie
          es tun.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Wie bei Bewertungen wird dabei etwas außerhalb unserer Server veröffentlicht, das wir
          nicht mehr rückgängig machen können. Bitte lesen Sie diesen Abschnitt daher vor dem
          Veröffentlichen.
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Zusätzliche OpenStreetMap-Berechtigungen.</strong> Die normale Anmeldung fragt
              nur die minimalen Berechtigungen <code>openid read_prefs</code> ab. Beim ersten
              Beitrag werden Sie zu OpenStreetMap weitergeleitet, um <code>write_api</code> (für
              Bearbeitungen) oder <code>write_notes</code> (für Hinweise) zu erteilen. Sie können
              diese Berechtigungen jederzeit in Ihren OpenStreetMap-Kontoeinstellungen widerrufen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Anbieter-Token.</strong> Die von OpenStreetMap ausgestellten Access- und
              Refresh-Token werden auf unserem Server gespeichert, dabei mit dem
              Authentifizierungsgeheimnis dieser Installation verschlüsselt und bei Bedarf erneuert,
              bis Sie die Verknüpfung aufheben oder Ihr Konto löschen. Token werden nie an Ihren
              Browser gesendet und erscheinen nicht in unseren Protokollen, Metriken oder
              Fehlermeldungen. Token, die vor Einführung der Verschlüsselung gespeichert wurden,
              bleiben lesbar und werden bei der nächsten Aktualisierung neu verschlüsselt; im
              seltenen Fall, dass ein solcher Altwert nicht mehr lesbar ist, werden Sie lediglich
              gebeten, das Konto erneut zu verknüpfen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Anfragen in Ihrem Namen.</strong> Wenn Sie den Editor öffnen, ruft unser
              Server &mdash; nicht Ihr Browser &mdash; OpenStreetMap auf, um das aktuelle Objekt,
              Ihre Kontodaten und Ihre Berechtigungen zu lesen und beim Veröffentlichen den
              Änderungssatz anzulegen und das Objekt zu aktualisieren. OpenStreetMap sieht dabei die
              IP-Adresse unseres Servers, nicht Ihre. Nur beim Autorisierungsschritt wird Ihr
              Browser direkt zu OpenStreetMap weitergeleitet; dabei kann OpenStreetMap Ihre
              IP-Adresse und Browser-Anfragedaten erhalten.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Was an OpenStreetMap übermittelt wird.</strong> Bei einer Bearbeitung: die
              Objektreferenz, die geänderten Tags, der von Ihnen verfasste Kommentar zum
              Änderungssatz, die von Ihnen gewählte Quelle, Ihre Oberflächensprache als{" "}
              <code>locale</code>-Tag, ein <code>created_by</code>-Tag mit OpenMapX und dessen
              Version sowie optional die Bitte um Gegenprüfung. Bei einem Hinweis: Ihr Text und die
              Koordinaten, die unser Server aus dem Objekt selbst berechnet. Werte aus unseren
              Anreicherungsdiensten werden niemals als Ihre Quelle hochgeladen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>
                Der Beitrag ist öffentlich und mit Ihrer OpenStreetMap-Identität verknüpft.
              </strong>{" "}
              Ihre Bearbeitung oder Ihr Hinweis wird unter Ihrem verknüpften OpenStreetMap-Konto
              veröffentlicht. Ihr OpenStreetMap-Benutzername, der Änderungssatz, Ihr Kommentar, Ihre
              Quellenangabe, die resultierenden Tags, der Hinweistext und Ihr Bearbeitungsverlauf
              werden Teil der öffentlichen Datenbank und Historie von OpenStreetMap. Diese Datenbank
              wird von der OpenStreetMap Foundation betrieben und unterliegt deren eigener{" "}
              <Link
                href="https://osmfoundation.org/wiki/Privacy_Policy"
                target="_blank"
                rel="noopener noreferrer"
              >
                Datenschutzerklärung
              </Link>{" "}
              und den{" "}
              <Link
                href="https://osmfoundation.org/wiki/Licence/Contributor_Terms"
                target="_blank"
                rel="noopener noreferrer"
              >
                Mitwirkendenbedingungen
              </Link>
              , die Sie vor dem Bearbeiten annehmen müssen &mdash; nicht unseren.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>
                Das Löschen Ihres OpenMapX-Kontos löscht Ihre OpenStreetMap-Historie nicht.
              </strong>{" "}
              Beim Löschen Ihres Kontos hier werden die gespeicherten Anbieter-Token und die
              Verknüpfung zu Ihrem OpenStreetMap-Konto entfernt. Auf bereits bei OpenStreetMap
              veröffentlichte Beiträge hat das keine Auswirkung; sie sind Teil einer öffentlichen,
              dauerhaft versionierten Datenbank und liegen außerhalb unseres Einflussbereichs.
              Anliegen dazu richten Sie bitte an die OpenStreetMap Foundation.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Kurzlebige Betriebsdaten.</strong> Damit ein Doppelklick nicht zweimal
              veröffentlicht, speichern wir kurzzeitig eine Sperre und das Ergebnis des Vorgangs.
              Die Schlüssel sind Einweg-HMAC-Digests aus Ihrer Benutzer-ID, der Objektreferenz und
              einer zufälligen Vorgangs-ID; die gespeicherten Werte enthalten nur öffentliche
              Ergebniskennungen (Änderungssatz- oder Hinweis-ID), die zugehörigen Links und einen
              Zeitstempel. Sperren verfallen nach zwei Minuten, erfolgreiche Ergebnisse nach 24
              Stunden, ein ungeklärtes Ergebnis nach zwei Minuten. Die Ratenbegrenzung führt einen
              ähnlichen kurzlebigen, digest-basierten Zähler. Eine Datenbank mit Beitragsinhalten
              führen wir nicht: weder Tags noch Kommentare, Hinweistexte oder Quellen werden hier
              gespeichert.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Protokolle und Metriken sind inhaltsfrei.</strong> Die Betriebstelemetrie
              erfasst nur, welche Art von Vorgang ausgeführt wurde, ob er erfolgreich war, wie lange
              er gedauert hat und eine zufällige Anfrage-ID. Objekte, Tags, Namen, Koordinaten,
              Kommentare, Hinweistexte, Quellen, Kontonamen oder Token werden nicht erfasst. Für
              Server-Protokolle gilt die übliche Speicherdauer aus Abschnitt&nbsp;14.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Rechtsgrundlage für das Speichern und Erneuern der OpenStreetMap-Token ist Art.&nbsp;6
          Abs.&nbsp;1 lit.&nbsp;b DSGVO (Erfüllung des von Ihnen angeforderten Beitragsdienstes).
          Rechtsgrundlage für die Veröffentlichung Ihres Beitrags bei OpenStreetMap ist Art.&nbsp;6
          Abs.&nbsp;1 lit.&nbsp;a DSGVO (Ihre ausdrückliche Einwilligung, erteilt, indem Sie eine
          Quelle wählen, einen eigenen Kommentar verfassen und &bdquo;In OpenStreetMap
          veröffentlichen&ldquo; auslösen, nachdem Ihnen genau angezeigt wurde, was übermittelt wird
          und dass es öffentlich ist). Sie können die Einwilligung für die Zukunft jederzeit
          widerrufen, indem Sie keine weiteren Beiträge veröffentlichen und die Berechtigungen in
          Ihrem OpenStreetMap-Konto entziehen; bereits veröffentlichte Beiträge können nicht
          einseitig zurückgenommen werden, da OpenStreetMap eine öffentliche Datenbank mit
          dauerhafter Bearbeitungshistorie ist. Soweit Ihr Beitrag dadurch an Empfänger außerhalb
          des Europäischen Wirtschaftsraums (EWR) übermittelt wird, stützt sich diese Übermittlung
          auf Ihre ausdrückliche Einwilligung nach Art.&nbsp;49 Abs.&nbsp;1 lit.&nbsp;a DSGVO.
        </Typography>
      </Section>
      <Section title={T.crowdReports}>
        <Typography>
          Wenn diese Instanz Verkehrs- und Gefahrenmeldungen anbietet, können Sie eine Lage auf der
          Straße melden, etwa einen Unfall, eine Gefahr oder eine Sperrung, und eine Meldung anderer
          bestätigen oder verneinen, wenn Sie sich ihr nähern. Ein Konto ist dafür nicht nötig.
          Meldungen gehen an den OpenConditions-Dienst, den der Betreiber dieser Instanz anbindet,
          und werden dort zu Verkehrsmeldungen für alle.
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>
                Eine Meldeidentität auf diesem Gerät, nicht mit Ihrem Konto verknüpft.
              </strong>{" "}
              Wenn Sie zum ersten Mal eine Meldung oder Rückmeldung senden, erzeugt Ihr Browser ein
              Schlüsselpaar und bewahrt es im lokalen Speicher dieses Browsers auf, zusammen mit
              einer Meldeberechtigung, die etwa einen Tag gilt und danach mit Ihrer nächsten Meldung
              oder Rückmeldung erneuert wird. Jede Meldung und jede Rückmeldung wird mit dem
              privaten Schlüssel signiert, der den Browser nie verlässt. Der Schlüssel wird nie mit
              Ihrem OpenMapX-Konto verbunden, und OpenMapX speichert Meldungen nicht in seiner
              eigenen Datenbank. Er wirkt als Pseudonym: OpenConditions kann erkennen, dass
              Meldungen vom selben Gerät stammen, aber nicht, von wem.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Was übermittelt wird.</strong> Eine Meldung enthält die Art der Lage, den von
              Ihnen gewählten Ort, optional die Schwere, den Zeitpunkt sowie den öffentlichen
              Schlüssel mit Signatur. Eine Rückmeldung enthält die Meldung, auf die sie sich
              bezieht, ob Sie sie bestätigen oder verneinen, den Zeitpunkt sowie den öffentlichen
              Schlüssel mit Signatur; da Sie nur gefragt werden, wenn Sie sich einer Meldung nähern,
              zeigt eine Rückmeldung auch, dass das Gerät zu dieser Zeit in der Nähe dieses Orts
              war. Der Server von OpenMapX leitet sie ohne Ihre IP-Adresse und ohne Browserangaben
              weiter; OpenConditions sieht nur den Server.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Was OpenConditions speichert.</strong> Gespeichert werden der öffentliche
              Schlüssel, wann er zuletzt genutzt wurde, und ein Zuverlässigkeitswert, der sich
              daraus ergibt, wie frühere Meldungen ausgegangen sind. Ihre Meldungen und
              Rückmeldungen bleiben mit dem Schlüssel verknüpft; über diese Verknüpfung wird
              geprüft, ob die Meldungen eines Geräts zusammen plausibel sind, und Missbrauch
              begrenzt. Ein Schlüssel, der 12&nbsp;Monate nicht genutzt wird, wird mit seinen
              Rückmeldungen gelöscht; seine Meldungen bleiben dann nur als nicht verknüpfte
              Verkehrsinformationen. Ein wegen Missbrauchs gesperrter Schlüssel bleibt auf der
              Sperrliste, solange die Sperre besteht.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Was veröffentlicht wird.</strong> Die daraus entstehenden Verkehrsmeldungen
              mit Ort, Art und Zeitpunkt werden allen Nutzenden angezeigt und können an andere
              Verkehrsinformationsdienste weitergegeben werden. Den Schlüssel enthalten sie nie.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Die Verknüpfung beenden.</strong> Wenn Sie die Websitedaten dieses Browsers
              löschen oder Ihr Konto in diesem Browser löschen, wird der Schlüssel vom Gerät
              entfernt. Danach kann niemand die Meldeidentität mehr mit Ihnen verbinden, und
              OpenConditions löscht sie 12&nbsp;Monate nach ihrer letzten Nutzung.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Rechtsgrundlage ist Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;f DSGVO: unser berechtigtes
          Interesse und das anderer Verkehrsteilnehmender an aktuellen und verlässlichen
          Informationen über Verkehr und Gefahren, einschließlich der Abwehr falscher und
          missbräuchlicher Meldungen.
        </Typography>
      </Section>
      <Section title={T.thirdParty}>
        <Typography>
          Um seine Kartenfunktionen bereitzustellen, sendet OpenMapX Anfragen an verschiedene
          Drittanbieter-APIs. Wenn Sie eine Funktion nutzen, werden bestimmte Daten (typischerweise
          Kartenausschnitt-Koordinaten, Suchanfragen oder Routenwegpunkte) an den jeweiligen
          Anbieter übermittelt. Unser Backend-Server fungiert für die meisten dieser Anfragen als
          Proxy, sodass Drittanbieter in der Regel die IP-Adresse unseres Servers und nicht Ihre
          Browser-IP-Adresse sehen. Nachfolgend eine vollständige Liste aller externen Dienste:
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Ein von Benutzern gewählter Dawarich-Ursprung ist in den nachfolgend generierten
          Anbietertabellen nicht enthalten, weil Betreiber und Standort vom Benutzer gewählt werden.
          Verwaltetes Dawarich ist ein optionaler First-Party-Dienst dieser Bereitstellung und kein
          Integrationsanbieter. In beiden Modi leitet OpenMapX Anfragen zum persönlichen Zeitstrahl
          wie in Abschnitt&nbsp;5 beschrieben weiter.
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
              service: "OpenFreeMap",
              purpose:
                "Vektorkacheln und Schrift-Glyphen bei Auswahl von OpenFreeMap; Glyphen-Fallback bei lokalen Kacheln ohne Schriftserver",
              dataSent:
                "Browser-IP-Adresse, Kachelkoordinaten und Glyphen-Anfragen; kann den sichtbaren Kartenausschnitt widerspiegeln",
              endUserExposure: "Direkt (Browser)",
              country: "Ungarn",
              privacy: "https://openfreemap.org/privacy/",
            },
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
                Soweit die Verarbeitung außerhalb des EWR stattfindet, erfolgt die Übermittlung auf
                Grundlage der vom konfigurierten Auftragsverarbeiter angegebenen Garantien, etwa
                eines Angemessenheitsbeschlusses oder der EU-Standardvertragsklauseln (Art.&nbsp;46
                Abs.&nbsp;2 lit.&nbsp;c DSGVO).
              </Typography>
            </>
          );
        })()}

        <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
          Sprachsuche (Mikrofon)
        </Typography>
        <Typography>
          Auf der Website bietet die Suchleiste optional eine Spracheingabe. Sie ist erst aktiv,
          wenn Sie die Schaltfläche drücken. Danach fragt Ihr Browser die Mikrofonberechtigung ab
          und wandelt Ihre Spracheingabe mit der browsereigenen Spracherkennung (Web Speech API) in
          Suchtext um. An unsere Server gelangt ausschließlich der resultierende Text als
          gewöhnliche Suchanfrage — die Audiodaten erhalten und speichern wir nicht.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Auf der Website entscheidet Ihr Browser, wo die Spracherkennung stattfindet, nicht
          OpenMapX. Chromium-basierte Browser (Chrome, Edge und die meisten Abkömmlinge) übertragen
          die aufgenommenen Audiodaten zur Transkription an den Cloud-Sprachdienst ihres
          Herstellers, für den dessen eigene Datenschutzerklärung gilt; andere Browser erkennen die
          Sprache gegebenenfalls lokal auf Ihrem Gerät oder bieten die Funktion nicht an — dann wird
          die Schaltfläche nicht angezeigt. Wenn Sie eine Verarbeitung durch Ihren Browserhersteller
          nicht wünschen, nutzen Sie die Sprachschaltfläche nicht; die Eingabe über die Tastatur
          verwendet kein Mikrofon.
        </Typography>

        <Typography sx={{ mt: 1 }}>
          In der installierten App nutzt die optionale Sprachsuche unter iOS und ab Android 13 die
          lokale Spracherkennung des Betriebssystems, sofern ein lokaler Dienst und das Sprachmodell
          verfügbar sind. Sie startet erst, wenn Sie die Mikrofontaste drücken und den
          Mikrofonzugriff und unter iOS die Spracherkennung erlauben. Die Audiodaten werden auf
          Ihrem Gerät verarbeitet und von OpenMapX weder übertragen noch gespeichert. Das
          Herunterladen eines fehlenden Sprachmodells benötigt eine Netzwerkverbindung; die
          Erkennung selbst nicht. Unter älteren Android-Versionen ist die Sprachsuche deaktiviert.
          Unter iOS muss die angeforderte Sprache offline unterstützt werden; es gibt keinen
          Server-Fallback. Das Transkript wird als gewöhnlicher Suchtext verwendet. Dafür gelten
          dieselben Regeln für Suchanfragen und den Suchverlauf wie bei getipptem Text. Die
          Spracheingabefunktion protokolliert keine Transkripte.
        </Typography>

        <Typography sx={{ mt: 2 }}>
          <strong>Hinweis zum Datenfluss:</strong> Die Spalte &quot;Datenzugriff&quot; oben zeigt
          an, wie jeder Dienst kontaktiert wird. &quot;Nur Server&quot; und &quot;Über Server
          (Proxy)&quot; bedeuten, dass Anfragen über unseren Backend-Server geleitet werden &mdash;
          der Drittanbieter sieht nur die IP-Adresse unseres Servers, nicht Ihre. &quot;Direkt
          (Browser)&quot; bedeutet, dass Ihr Browser direkt mit dem Anbieter verbunden wird, wobei
          Ihre IP-Adresse und Ihr Browser-Fingerabdruck offengelegt werden. &quot;Gemischt&quot;
          bedeutet, dass Katalog- oder Metadaten-Anfragen serverseitig oder über Proxy laufen,
          einzelne Medien- oder Player-Assets aber direkt durch Ihren Browser geladen werden können,
          nachdem Sie eine ausdrückliche Aktion ausführen, etwa einen Viewer-Hinweis bestätigen oder
          &quot;Medien laden&quot; anklicken. Die überwiegende Mehrheit der Dienste ist serverseitig
          oder über Proxy angebunden. MapTiler-Karten-Assets werden standardmäßig über unseren
          API-Proxy geleitet. Wenn ein Betreiber öffentliche Karten-, Stil- oder Kachel-URL-Vorlagen
          auf externe Anbieter konfiguriert, kontaktiert Ihr Browser diese konfigurierten Anbieter
          direkt für diese Assets.
        </Typography>

        <Typography sx={{ mt: 2 }}>
          <strong>Internationale Übermittlungen:</strong> Einige der oben genannten Dienste werden
          von Unternehmen in den USA oder anderen Ländern außerhalb des Europäischen
          Wirtschaftsraums (EWR) betrieben. Eine Übermittlung personenbezogener Daten in ein
          Drittland findet nur statt, wenn Ihre Daten (z.&nbsp;B. Ihre IP-Adresse oder Koordinaten)
          tatsächlich den jeweiligen Anbieter erreichen:
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Direkte Browser-Verbindungen zu Medienanbietern:</strong> Einige Webcam-Video-
              oder Player-Anbieter können Ihre IP-Adresse und Browser-/Geräte-Anfragedaten erhalten,
              wenn Sie &quot;Medien laden&quot; anklicken oder Live-Medien anderweitig öffnen.
              Abdeckung, Metadaten und Bilddateien der Straßenansicht werden über unseren API-Proxy
              geleitet.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Proxy-Anfragen zu Anbietern außerhalb des EWR:</strong> MapTiler Cloud erhält
              proxy-weitergeleitete Karten-Asset-Anfragen, wenn es als Kartenanbieter konfiguriert
              ist. MapTiler AG sitzt in der Schweiz, für die ein EU-Angemessenheitsbeschluss
              besteht.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Server-seitig weitergeleitete Koordinaten:</strong> Für Dienste wie Flickr,
              Wikimedia Commons, TransitLand und Link kann unser Backend
              Kartenausschnitt-Koordinaten (nicht Ihre IP-Adresse) als Teil der Anfrage
              weiterleiten. Diese Koordinaten spiegeln den auf der Karte angezeigten Bereich wider
              und sind nicht unmittelbar mit Ihrer Identität oder Ihrem physischen Standort
              verknüpft.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Keine Übermittlung personenbezogener Daten:</strong> Einige US-basierte
              Dienste (GitHub API) erhalten keinerlei nutzerbezogene Daten. Unser Server ruft
              Repository-Dateien ab, ohne Koordinaten, Suchanfragen oder Nutzerkennungen zu
              übermitteln. In diesen Fällen findet keine Übermittlung personenbezogener Daten statt.
              NASA FIRMS und USGS kontaktiert unser Server nicht mehr: Gefahrendaten von ihnen
              erreichen OpenMapX über die OpenConditions-Instanz, die deren öffentliche Feeds ohne
              Nutzerdaten abruft.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Rechtsgrundlage für alle Drittanbieter-Anfragen ist Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;f
          DSGVO (berechtigtes Interesse an der Bereitstellung des von Ihnen genutzten
          Kartendienstes).
        </Typography>
      </Section>
      <Section title={T.cookies}>
        <Typography>
          OpenMapX verwendet ausschließlich First-Party-Speichermechanismen. Speicher, der für den
          Dienst erforderlich ist, wird ohne Consent-Banner verwendet. Der optionale Cache für
          kürzliche Kartendaten ist standardmäßig deaktiviert und wird nur aktiviert, wenn Sie ihn
          in den Einstellungen einschalten.
        </Typography>
        <ul>
          <li>
            <Typography>
              <strong>Sitzungs-Cookie</strong> &mdash; Wenn Sie sich anmelden, wird ein
              HTTP-only-Sitzungs-Cookie gesetzt, um Ihre Anfragen zu authentifizieren. Dieses Cookie
              ist für die Anmeldefunktion unerlässlich und wird gelöscht, wenn Sie sich abmelden
              oder es abläuft.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Spracheinstellungs-Cookie</strong> (<code>NEXT_LOCALE</code>) &mdash; Wenn Sie
              die Sprache der Oberfläche explizit wechseln, wird Ihre Wahl (z.&nbsp;B.
              &quot;en&quot; oder &quot;de&quot;) in einem First-Party-Cookie (max-age: 1&nbsp;Jahr,
              SameSite: lax) gespeichert, damit die Oberfläche Ihre Wahl bei erneuten Besuchen
              beibehält. Dieses Cookie wird nur gesetzt, wenn Sie aktiv eine Sprache auswählen. Wenn
              Sie keine explizite Wahl getroffen haben, wird automatisch die Spracheinstellung Ihres
              Browsers verwendet, ohne ein Cookie zu speichern.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Ansichtseinstellungen</strong> &mdash; Eine kleine Anzahl von
              Anzeigeeinstellungen (z.&nbsp;B. Globus- vs. Flachkartenprojektion) wird im
              localStorage gespeichert, damit die Oberfläche Ihre zuletzt genutzte Ansicht
              wiederherstellt. Es sind keine personenbezogenen Daten betroffen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Schlüssel für Verkehrsmeldungen</strong> (
              <code>openconditions.contrib.deviceKey</code>,{" "}
              <code>openconditions.contrib.grant</code>) &mdash; Wenn Sie eine Verkehrs- oder
              Gefahrenmeldung oder eine Rückmeldung senden, werden das Schlüsselpaar und die
              aktuelle Meldeberechtigung im localStorage gespeichert (siehe Abschnitt&nbsp;8). Sie
              bleiben, bis Sie die Websitedaten dieses Browsers löschen oder Ihr Konto in diesem
              Browser löschen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Service-Worker-Cache</strong> &mdash; Ein Service Worker speichert statische
              Ressourcen (HTML, CSS, JavaScript), Online-Kartenkacheln und versionierte
              Glyphen-Ressourcen für Offline-Pakete über die Cache-Storage-API des Browsers
              zwischen. Offline-Kartenarchive werden in IndexedDB oder im Origin Private File System
              gespeichert und vor der Verwendung verifiziert. Dies ermöglicht Offline-Funktionalität
              und schnelleres Laden. Zwischengespeicherte Einträge laufen automatisch ab (statische
              Ressourcen: 30&nbsp;Tage; Online-Kartenkacheln: 3&ndash;7&nbsp;Tage). Laufzeit-Caches
              für API-Antworten zu Suche, Routen, Orten, Autovervollständigung, Wetter und
              Foto-Lookups werden nur geschrieben, wenn Sie den Cache für kürzliche Kartendaten
              aktivieren.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Browser-Speicher-Cache</strong> &mdash; API-Antworten werden zusätzlich im
              Browserspeicher (via TanStack Query) während Ihrer Sitzung zwischengespeichert. Diese
              Daten werden beim Schließen des Tabs verworfen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Optionaler Cache für kürzliche Kartendaten</strong> &mdash; Wenn Sie in den
              Einstellungen &quot;Kürzliche Kartendaten auf diesem Gerät merken&quot; aktivieren,
              speichert OpenMapX eine kuratierte Auswahl kürzlicher kartenbezogener API-Antworten in
              localStorage und Cache Storage. Dies kann eingegebene Suchtexte, Routen-Wegpunkte,
              Ortsdetails, Wetter-Lookups, Foto-Lookup-Ergebnisse, Ergebnisse in der Nähe und genaue
              Kartenkoordinaten umfassen. Einträge laufen je nach Cache-Typ automatisch ab (meist
              innerhalb von Minuten bis 24&nbsp;Stunden; Foto-Lookup-Caches können bis zu
              7&nbsp;Tage gespeichert bleiben). Sie können die Einstellung jederzeit deaktivieren
              oder diese Daten in den Speichereinstellungen löschen.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Wir verwenden <strong>keine</strong> Tracking-Cookies, Analyse-Cookies oder Werbe-Cookies.
          Für unbedingt erforderliche Speichermechanismen ist kein Cookie-Consent-Banner
          erforderlich (&sect;&nbsp;25 Abs.&nbsp;2 TDDDG, Umsetzung von Art.&nbsp;5 Abs.&nbsp;3
          ePrivacy-Richtlinie). Der optionale Cache für kürzliche Kartendaten ist standardmäßig
          deaktiviert und wird über eine ausdrückliche First-Party-Einstellung gesteuert, nicht über
          ein Tracking-Banner.
        </Typography>
      </Section>
      <Section title={T.caching}>
        <Typography>
          Um die Leistung zu verbessern und die Last auf Drittanbieter-APIs zu reduzieren, speichert
          unser Server API-Antworten in Redis (einem In-Memory-Datenspeicher) zwischen.
          Zwischengespeicherte Daten umfassen typischerweise Kartensuchergebnisse, Fahrpläne,
          Routenantworten und Katalogdaten externer Verzeichnisse. Cache-Einträge laufen automatisch
          ab (in der Regel innerhalb von Minuten bis 48&nbsp;Stunden). Diese Einträge werden Ihrem
          Konto nicht zugeordnet und enthalten weder Ihre IP-Adresse noch Ihren
          Authentifizierungsstatus. Such- oder Routeneingaben und -ergebnisse können dennoch
          Koordinaten oder Ortsnamen enthalten, die ein geografisches Interessengebiet erkennen
          lassen.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Antworten des persönlichen Zeitstrahls sind ausdrücklich von Redis-, Service-Worker-,
          persistenten Abfrage- und Browser-Speicher-Caches ausgeschlossen. Nur ein nicht
          benutzerbezogenes Ergebnis der Zustandsprüfung des verwalteten Dienstes darf höchstens
          15&nbsp;Sekunden im Serverspeicher gehalten werden; es enthält weder Zeitstrahl-, Konto-,
          Zugangs-, Hostnamen- noch Anfragedatumsdaten.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Wir betreiben außerdem eine PostgreSQL-Datenbank für Benutzerkonten, gespeicherte Orte,
          Fahrzeuge und Parkpositionen, Freigabeinhalte sowie gecachte Ortsanreicherungsdaten
          (z.&nbsp;B. Wikidata-Fakten, Wikipedia-Zusammenfassungen). Die Konto- und synchronisierten
          Inhalte sind personenbezogene und serverseitig lesbare Daten. Wenn GTFS-Nahverkehrs-Feeds
          importiert werden, werden Fahrplandaten (Haltestellennamen, Linien, Abfahrtszeiten) in
          separaten Datenbank-Schemas gespeichert; gecachte öffentliche Ortsinformationen und
          Fahrpläne sind keine Kontodaten.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Wenn Sie die OpenStreetMap-Beitragsfunktion nutzen, werden kurzzeitig eine Sperre und ein
          Ergebnisdatensatz vorgehalten (in Redis, sofern konfiguriert, sonst im Arbeitsspeicher),
          ausschließlich um eine doppelte Einreichung zu verhindern. Deren Schlüssel sind
          Einweg-Digests, deren Werte enthalten nur öffentliche Ergebniskennungen und Zeitstempel
          &mdash; niemals Beitragsinhalte. Siehe Abschnitt&nbsp;7.
        </Typography>
      </Section>
      <Section title={T.email}>
        <Typography>
          Wenn Sie ein Konto registrieren, können wir transaktionale E-Mails senden für:
        </Typography>
        <ul>
          <li>
            <Typography>E-Mail-Adress-Verifizierung</Typography>
          </li>
          <li>
            <Typography>Passwort-Zurücksetzungsanfragen</Typography>
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
                  Diese E-Mails werden über {email.vendorName}
                  {country ? ` (${country})` : ""} versendet &mdash; einen Dienstleister, der in
                  unserem Auftrag und nach unserer Weisung tätig wird (Auftragsverarbeiter gemäß
                  Art.&nbsp;28 DSGVO)
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
                  Diese E-Mails werden über einen von uns betriebenen bzw. beauftragten SMTP-Server
                  versendet.{" "}
                </>
              )}
              Sie enthalten nur die für die jeweilige Aktion notwendigen Informationen. Wir
              versenden keine Newsletter oder Marketing-E-Mails. Rechtsgrundlage ist Art.&nbsp;6
              Abs.&nbsp;1 lit.&nbsp;b DSGVO (Vertragserfüllung / Bereitstellung des von Ihnen
              angeforderten Dienstes).
            </Typography>
          );
        })()}
      </Section>
      <Section title={T.rights}>
        <Typography>Sie haben folgende Rechte bezüglich Ihrer personenbezogenen Daten:</Typography>
        <ul>
          <li>
            <Typography>
              <strong>Auskunftsrecht</strong> (Art.&nbsp;15 DSGVO) &mdash; Sie können Auskunft
              darüber verlangen, welche personenbezogenen Daten wir verarbeiten.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Recht auf Berichtigung</strong> (Art.&nbsp;16 DSGVO) &mdash; Sie können die
              Berichtigung unrichtiger Daten verlangen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Recht auf Löschung</strong> (Art.&nbsp;17 DSGVO) &mdash; Sie können die
              Löschung Ihrer Daten verlangen. Sie können Ihr Konto auch direkt in den
              Kontoeinstellungen löschen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Recht auf Einschränkung der Verarbeitung</strong> (Art.&nbsp;18 DSGVO) &mdash;
              Sie können verlangen, dass wir die Verarbeitung Ihrer Daten einschränken.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Recht auf Datenübertragbarkeit</strong> (Art.&nbsp;20 DSGVO) &mdash; Sie
              können verlangen, Ihre Daten in einem strukturierten, gängigen, maschinenlesbaren
              Format zu erhalten.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Widerspruchsrecht</strong> (Art.&nbsp;21 DSGVO) &mdash; Sie können jederzeit
              der Verarbeitung auf Grundlage berechtigter Interessen widersprechen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Recht auf Widerruf der Einwilligung</strong> (Art.&nbsp;7 Abs.&nbsp;3 DSGVO)
              &mdash; Soweit die Verarbeitung auf einer Einwilligung beruht (z.&nbsp;B.
              Standortdaten), können Sie diese jederzeit widerrufen, indem Sie die
              Browser-Berechtigung zurückziehen.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Um eines dieser Rechte auszuüben, kontaktieren Sie uns unter der oben genannten
          E-Mail-Adresse. Sie haben außerdem das Recht, Beschwerde bei einer Aufsichtsbehörde
          einzulegen (Art.&nbsp;77 DSGVO).
          {supervisoryAuthority && (
            <>
              {" "}
              Zuständige Aufsichtsbehörde ist: {supervisoryAuthority}
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
          personenbezogenen Daten nicht für eine automatisierte Entscheidungsfindung einschließlich
          Profiling im Sinne des Art.&nbsp;22 DSGVO.
        </Typography>
      </Section>
      <Section title={T.retention}>
        <Typography>Wir speichern personenbezogene Daten nur so lange wie nötig:</Typography>
        <ul>
          <li>
            <Typography>
              <strong>Kontodaten</strong> &mdash; werden aufbewahrt, bis Sie Ihr Konto löschen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Gespeicherte Orte</strong> &mdash; werden aufbewahrt, bis Sie sie entfernen
              oder Ihr Konto löschen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Fahrzeuge und Parkposition</strong> &mdash; werden aufbewahrt, bis Sie die
              Parkposition löschen, das Fahrzeug entfernen oder Ihr Konto löschen. Beim Löschen
              eines Fahrzeugs wird auch dessen Parkposition entfernt. Eine Parkposition mit
              Parkzeitbegrenzung wird 30&nbsp;Tage nach deren Ablauf gelöscht.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Freigabelinks</strong> — werden aufbewahrt, bis Sie den Link widerrufen oder
              Ihr Konto löschen. Ein Link mit Ablaufdatum wird 30&nbsp;Tage nach seinem Ablauf
              gelöscht.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Sitzungen, Anmeldebestätigungen und Tokens verbundener Apps</strong> — werden
              30&nbsp;Tage nach ihrem Ablauf gelöscht.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Belege administrativer Änderungen</strong> — Aufzeichnungen darüber, dass eine
              Administratorin oder ein Administrator ein Konto, die Anmelderichtlinie oder eine
              Integration geändert hat, werden ein Jahr nach der Änderung gelöscht. Der neueste
              Beleg je Integration und je Konto bleibt erhalten, bis ein neuerer ihn ersetzt.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Protokoll administrativer Tätigkeiten</strong> — Aufzeichnungen darüber, was
              Administratorinnen und Administratoren getan haben, etwa die Rolle eines Kontos
              geändert, ein Konto gesperrt oder gelöscht oder Einstellungen geändert, mit IP-Adresse
              und Browser der handelnden Person, werden nach{" "}
              {auditLogRetentionDays !== null
                ? `${auditLogRetentionDays} Tagen`
                : "der vom Betreiber eingestellten Frist (standardmäßig 365 Tage)"}{" "}
              gelöscht. Das Löschen eines Kontos entfernt es aus den Einträgen, die es nennen,
              zusammen mit IP-Adresse und Browser, die zu seinen eigenen Handlungen erfasst wurden.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Aufzeichnungen über Offenlegungen an Empfänger</strong> — werden drei Jahre
              nach der Offenlegung gelöscht.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Datensätze zu Offline-Paketen</strong> — werden aufbewahrt, bis das Paket
              entfernt wird oder Sie Ihr Konto löschen. Datensätze eines gelöschten Kontos, die eine
              Wiederherstellung aus einer Sicherung zurückbringt, werden 30&nbsp;Tage nach ihrer
              Erfassung gelöscht.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Verbindung zum persönlichen Zeitstrahl</strong> &mdash; der verschlüsselte
              API-Schlüssel und sichere Verbindungsmetadaten werden bis zur Trennung oder Löschung
              Ihres OpenMapX-Kontos aufbewahrt. Abgerufene Verläufe werden von OpenMapX nicht
              aufbewahrt. Das Deaktivieren des verwalteten Dawarich erhält dessen getrennte
              Dienst-Volumes; Aufbewahrung und Löschung des Dawarich-Kontos und -Verlaufs richten
              sich nach dem Instanzbetreiber und den direkten Dawarich-Kontoeinstellungen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Lokales Mangrove-Schlüsselpaar</strong> — bleibt bis zum Ersetzen, Löschen
              oder Löschen Ihres OpenMapX-Kontos gespeichert, vorbehaltlich der Lösch- und
              Sicherungsregeln dieser Erklärung. Dadurch wird weder die separate Identität beim
              gemeinsamen Signierdienst gelöscht noch eine bereits im Mangrove-Netzwerk
              veröffentlichte Bewertung widerrufen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Veröffentlichte Bewertungsinhalte</strong> &mdash; verbleiben im
              Mangrove-Netzwerk und seinen Spiegeln außerhalb unserer Kontrolle. Innerhalb der
              Anzeige von OpenMapX können Bewertungen auf Wunsch ausgeblendet werden; bei externen
              Aggregatoren richtet sich die Aufbewahrung nach deren jeweiligen Richtlinien.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>OpenStreetMap-Anbieter-Token</strong> &mdash; werden (verschlüsselt)
              aufbewahrt, bis Sie die Verknüpfung aufheben oder Ihr Konto löschen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Veröffentlichte OpenStreetMap-Beiträge</strong> &mdash; sind Teil der
              öffentlichen Datenbank und der dauerhaften Bearbeitungshistorie von OpenStreetMap und
              liegen außerhalb unserer Kontrolle. Das Löschen Ihres OpenMapX-Kontos entfernt sie
              nicht.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Betriebsdaten zu Beiträgen</strong> &mdash; Sperren verfallen nach zwei
              Minuten, erfolgreiche Ergebnisdatensätze nach 24&nbsp;Stunden; beide enthalten keine
              Beitragsinhalte.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Verkehrs- und Gefahrenmeldungen</strong> &mdash; die Meldeidentität wird von
              OpenConditions 12&nbsp;Monate nach ihrer letzten Nutzung zusammen mit ihren
              Rückmeldungen gelöscht; ihre Meldungen bleiben nur als nicht verknüpfte
              Verkehrsinformationen erhalten (siehe Abschnitt&nbsp;8). Der Schlüssel auf Ihrem Gerät
              bleibt, bis Sie die Websitedaten dieses Browsers löschen oder Ihr Konto in diesem
              Browser löschen.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Gespeicherte Anwendungsprotokolle</strong> &mdash; werden nach{" "}
              {serverLogRetentionDays}
              &nbsp;Tagen automatisch gelöscht. Container- und Laufzeitprotokolle richten sich nach
              der Infrastruktur-Richtlinie des Betreibers.
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
              <strong>Sicherungskopien</strong> &mdash;{" "}
              {backupRetentionDays !== null
                ? `Sicherungen werden gemäß der eingestellten Aufbewahrung bis zu ${backupRetentionDays} Tage aufbewahrt`
                : "Sicherungen werden für die vom Betreiber eingestellte Aufbewahrungsfrist (standardmäßig 30 Tage) aufbewahrt"}{" "}
              und ausschließlich zur Wiederherstellung nach einem Ausfall verwendet, nicht für
              andere Verarbeitungen. Kürzlich gelöschte oder geänderte Daten können bis zum Ablauf
              der Sicherungen darin verbleiben: Das Löschen von Live-Daten schreibt eine Sicherung
              nicht um. Bei einer Wiederherstellung wird ein pseudonymes Löschjournal abgespielt,
              sodass gelöschte Konten gelöscht bleiben. Fragen zu Ihren Daten in Sicherungen richten
              Sie an {email}.
            </Typography>
          </li>
          <li>
            <Typography>
              <strong>Lokaler Speicher und Service-Worker-Cache</strong> &mdash; die OpenMapX-Daten
              dieses Browsers werden nach erfolgreicher Kontolöschung entfernt. Auf anderen Geräten
              bleiben lokale Daten, bis dort Browser-/App-Daten gelöscht werden oder Cache-Einträge
              ablaufen.
            </Typography>
          </li>
        </ul>
        <Typography sx={{ mt: 1 }}>
          Solange eine Datenschutzanfrage zu Ihrer Person offen ist, werden Ihre Sitzungen, Tokens,
          Freigabelinks, Parkpositionen, Belege und Aufzeichnungen über Offenlegungen, die bei der
          Anfrage bereits bestanden, bis zum Abschluss der Anfrage aufbewahrt, auch wenn ihre Frist
          früher endet.
        </Typography>
      </Section>
      <Section title={T.security}>
        <Typography>
          Wir setzen angemessene technische und organisatorische Maßnahmen zum Schutz Ihrer Daten
          ein, darunter verschlüsselte Verbindungen (TLS/HTTPS), gehashte Passwörter (mit modernen
          Schlüsselableitungsfunktionen), sichere Sitzungsverwaltung und parametrisierte
          Datenbankabfragen. Jedoch ist keine Methode der Übertragung über das Internet zu
          100&nbsp;% sicher.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          <strong>
            Gewöhnliche synchronisierte Inhalte sind nicht Ende-zu-Ende-verschlüsselt.
          </strong>{" "}
          Gespeicherte Orte, geteilte Routen- oder Listenschnappschüsse, Fahrzeugprofile,
          Parkpositionen und Verbindungsmetadaten des persönlichen Zeitstrahls müssen dem
          OpenMapX-Server zur Synchronisierung, Freigabe oder Verarbeitung zugänglich sein. Sie
          können daher vom Betreiber dieser Installation und von einem kompromittierten
          Anwendungsserver eingesehen werden. Die Verschlüsselung ausgewählter Zugangsdaten im
          Ruhezustand und TLS beim Transport ändern diese Grenze nicht.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          <strong>Vertrauensmodell für Mangrove-Signaturen (Abschnitt&nbsp;5).</strong> Beim
          gemeinsamen Signierdienst vertrauen Sie Mangrove den Schutz und die Verwendung des
          privaten Schlüssels an; Mangrove erhält Bewertung und Sitzungstoken über unsere
          Schnittstelle. Bei der erweiterten lokalen Signierung verschlüsselt der Browser den
          privaten Schlüssel vor dem Hochladen mit einer Passphrase oder einem unterstützten
          Passkey. Eine ausschließliche Datenbankoffenlegung zeigt Chiffrat statt eines nutzbaren
          lokalen privaten Schlüssels. Lokale Verschlüsselung schützt einen entsperrten Schlüssel
          oder Bewertungsinhalte nicht vor kompromittiertem Anwendungscode. Beide Wege
          veröffentlichen lesbare Bewertungen; keiner verschlüsselt veröffentlichte Bewertungen.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          <strong>OAuth-Anbieter-Token.</strong> Von OpenStreetMap und Mapillary ausgestellte Token
          werden mit dem Authentifizierungsgeheimnis dieser Installation verschlüsselt gespeichert,
          sodass eine Offenlegung der Datenbank allein keine nutzbaren Token ergibt. Da ein
          OpenStreetMap-Token die Berechtigung enthalten kann, in Ihrem Namen die öffentliche Karte
          zu bearbeiten, prüft die Beitragsschnittstelle Ihre Berechtigungen zusätzlich unmittelbar
          vor jedem Schreibvorgang erneut bei OpenStreetMap selbst, statt sich auf den gespeicherten
          Stand zu verlassen.
        </Typography>
        <Typography sx={{ mt: 1 }}>
          Zugangsdaten des persönlichen Zeitstrahls werden vor der Datenbankspeicherung
          verschlüsselt, aus Antworten, Protokollen, Auditdetails und Metriken ausgeschlossen und
          nur vom Backend über die validierte Verbindung an die gewählte Dawarich-API gesendet. Der
          Browser ruft die Dawarich-API niemals direkt auf. Eine verwaltete Browser-SSO-Sitzung
          gewährt OpenMapX keinen Verlaufszugriff; der benutzerspezifische API-Schlüssel bleibt ein
          getrenntes Zugangsmittel.
        </Typography>
      </Section>
      <Section title={T.children}>
        <Typography>
          OpenMapX richtet sich nicht an Kinder unter 16&nbsp;Jahren. Wir erheben wissentlich keine
          personenbezogenen Daten von Kindern. Wenn Sie glauben, dass ein Kind uns personenbezogene
          Daten übermittelt hat, kontaktieren Sie uns bitte, damit wir diese löschen können.
        </Typography>
      </Section>
      <Section title={T.changes}>
        <Typography>
          Wir können diese Datenschutzerklärung von Zeit zu Zeit aktualisieren. Die aktuelle Version
          ist stets unter <Link href="/privacy">/privacy</Link> verfügbar. Wesentliche Änderungen
          werden durch Aktualisierung des Datums &quot;Zuletzt aktualisiert&quot; kenntlich gemacht.
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
            <TableCell sx={{ fontWeight: 600 }}>Übermittelte Daten</TableCell>
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
