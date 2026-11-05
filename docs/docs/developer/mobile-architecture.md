---
title: Mobile architecture
description: Installed-shell capabilities, navigation authority, bridge messages and trust boundaries.
sidebar_position: 9
---

# Mobile architecture

The installed app renders the web UI in a React Native WebView at a fixed origin.
The shell restricts navigation and exposes a versioned bridge. It answers the
page's one-shot requests (a location fix, opening OS settings and a
system-browser sign-in) and runs native ground and transit navigation sessions.

`apps/mobile/src/App.tsx` composes `createShellServices` (`src/shell/shellServices.ts`)
and `createForegroundNavigation` (`src/navigation/createForegroundNavigation.ts`)
into `createShellBridge`. Navigation commands go to the `NavigationCoordinator`;
everything else falls back to the shell services, and a command neither handles
receives `unsupported-capability`. The handshake reports ground and transit
navigation and background location as available, local notifications once the
notification permission is granted, and speech when the native audio module is
present. Installed-device evidence covers Android only; see
[Mobile feasibility](./mobile-feasibility.md) for what has been qualified.

## Why there is a split at all

Native navigation components are intended to own work that must continue when
the WebView is suspended: location delivery, progress, cues, alerts and durable
session state. The web UI owns phone rendering, search, route planning and place details.
Android Auto adds the narrow exception described below: the shell plans car trips
and owns a second map WebView and host templates.

A browser or PWA uses browser navigation facilities. Inside the installed shell,
the web runtime selects native authority before the handshake and disables its
browser engine. A shell that reports no navigation capability does not enable a
browser fallback. This avoids competing location streams, speech and session
records.

## The authority matrix

| Concern                                                               | Browser or PWA                            | Installed shell                                                                                                 |
| --------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Rendering, search and route planning                                  | Web UI                                    | Web UI                                                                                                          |
| Browser geolocation, speech, notifications and navigation persistence | Browser facilities                        | Disabled by the shell descriptor                                                                                |
| Ground and transit navigation                                         | Browser engine                            | Native coordinator, reported available                                                                          |
| Background location, local alerts and speech                          | Subject to browser limits                 | Native; alerts need the notification grant                                                                      |
| Durable native session                                                | Not used                                  | SQLite session, resumed after a process restart                                                                 |
| One-shot location, settings and authentication commands               | Browser flows                             | Answered by the shell services                                                                                  |
| Deep-link delivery                                                    | Browser flows                             | OS URLs validated, queued through document loading, delivered after bridge negotiation                          |
| Community frontend bundles                                            | Disabled                                  | Disabled                                                                                                        |
| Microphone input                                                      | Subject to browser support and permission | Native on-device search on iOS and Android 13+ when the voice probe answers available; WebView capture disabled |

The immutable descriptor is injected before page scripts run. Shell restrictions
use that descriptor, so they apply during negotiation, incompatibility and errors.
`MobileRuntimeProvider.tsx` is the web authority boundary;
`createShellBridge.ts` supplies the current capability report.

## Native navigation

`createForegroundNavigation` builds one coordinator per foreground app and
registers it, so the background location task feeds the same instance instead
of opening a second, headless one beside it. The headless coordinator is used
only when the OS starts the task without the app.

- **Start.** `session.start` runs the `PermissionController`. Its screens are
  native (`PermissionPrompts.tsx`) because the page may be suspended during the
  OS prompts. On Android 11 and later the background step is the system's
  background-location request, which opens the app's own location page with
  "Allow all the time". The first start also asks once for notification
  permission, for transit alight alerts.
- **Location.** expo-location delivers batches to the task registered in
  `defineNavigationTask.ts`. expo-task-manager schedules a persisted job, so the
  app holds `RECEIVE_BOOT_COMPLETED`; without it the first location update
  crashes the process. The app does not start anything at boot.
- **Storage.** expo-sqlite runs each exclusive transaction on its own
  connection, so `getDatabase` queues writes on the one handle and sets a busy
  timeout. Without the queue a diagnostic write and a batch commit collide with
  "database is locked".
- **Reroute.** A `reroute` effect only starts the request
  (`createRemoteWork.ts`). The answer re-enters the coordinator as a queued
  `applyReroute`, which applies it only while the session and its pending
  request id still match. A newer request aborts the one in flight.
- **Transit refresh and replan** are not wired yet. Their effects are no-ops,
  and the session keeps running on its captured itinerary.

## Android Auto surface and runtime

The native car surface is a deliberate, narrow exception to the rule that map
rendering belongs to the phone WebView. It is still web map rendering: the car
service owns a second WebView inside a Presentation on a VirtualDisplay supplied
with the host surface. It loads the map-only `/car` page. Directions, lanes and
arrival estimates use Android for Cars templates rather than phone web chrome.
The headless navigation bundle does not import the web renderer or MapLibre GL JS.

`OpenMapXCarRuntime` runs through the application's existing ReactHost without
requiring the phone Activity. It reuses the foreground coordinator when present,
or composes car-capable reroute/audio ports over the same executor and SQLite
repository. Committed snapshots fan out independently to phone and car; the car
page is a passive projection, not another navigation engine. Car commands enter
the same authority, including host stop. Car route planning uses the compiled
public API and a bounded instance/account-scoped destinations cache from the phone.

A connected car does not imply permission to start an Android location foreground
service. Car starts currently need background location permission plus a focused
phone Activity or an already-running location service. General car-only cold-start
trip creation remains unqualified. See [Android Auto](./android-auto.md) for the
surface protocol, privacy boundaries, DHU procedure and release limits. This does
not add Android Automotive OS or CarPlay support.

## Native screens

The loading and error overlays, the recovery screen and the permission screens
are drawn natively. They use the web UI's colours from `@openmapx/core/theme`,
the same module the web's MUI theme is built from, and follow the system light
or dark appearance. The Android notification tint, the adaptive icon background
and the splash backgrounds in `app.config.ts` come from the same module. The
native screens use the system font, not the web's Plus Jakarta Sans.

## One-shot location

`location.request` reads one position through the process-wide location driver
and never opens a stream beside a running session. When the app has never asked
for location, the request comes from the user's own tap on a location control,
so the shell shows the When-In-Use prompt, and only while the app is in front.
It never asks for background access; that belongs to the navigation start flow.
After a refusal it answers `denied` without prompting again.

## The bridge protocol

Both sides support protocols **v3 through v4**. The constants in
`packages/core/src/navigation/mobileProtocol.ts` and the release descriptor in
`apps/mobile/release/version.json` agree on `min: 3, max: 4`. Protocol 3 retains navigation; protocol 4 adds the optional `nativeIntake` capability. A non-overlapping
range leaves navigation disabled and requires an update. Protocol negotiation
alone does not establish that a command is implemented.

### Rollout order

Before changing the protocol, identify the actually deployed shell and web
versions. Define and test their overlap, deploy a compatible web build, then ship
the native build and enable the new capability. New web builds accept older protocol-3 shells. New shells omit `nativeIntake`
from protocol-3 hello replies and suppress intake events. Android Auto’s optional
`carDestinations` key is also omitted for these older strict hello schemas; a
protocol-4 peer receives both capabilities. Queued navigation
messages are stamped only after negotiation, so a pre-handshake restore remains
readable by the older page. Pending inbox items survive until a compatible page
opens them, the user discards them, or their 24-hour expiry.

Voice input uses a correlated `voice.probe` / `voice.availability` exchange after
negotiation, without changing either strict hello payload or the protocol version.
New APK + old web: hello is unchanged and old web never probes. Old APK + new web:
the unknown probe is silently rejected and times out, keeping voice hidden while
navigation remains negotiated. iOS and Android below API 33 answer unavailable.

### What crosses, and what does not

The bridge carries bounded commands, route and itinerary data, snapshots and
correlated results. The message ceiling is 8 MiB, with aggregate limits of
100,000 coordinates, 10,000 steps and 512 legs. The receiver checks origin,
document nonce, message bounds, schemas, duplicates and negotiated protocol before
dispatch. Some route fields deliberately preserve engine-specific extras; the
whole payload still has a byte limit.

It has no arbitrary JavaScript, SQL, file access, native method invocation or
free-form speech command. Session cookies, passwords, TOTP secrets and passkey
assertions do not belong in bridge messages. The authentication contract does
allow a single-use callback code, state and PKCE verifier in `auth.result`; the
page needs them to redeem the handoff. Keep these out of persistence, diagnostics
and URLs that should contain only a challenge.

A full snapshot can rehydrate the page at the current revision. A delta applies
only to its matching session, route and base revision; a gap requests a full
snapshot. The snapshot reducer and tests implement this contract independently
of the unfinished foreground composition.

### Voice input messages

- Web → native: `voice.probe` requests availability; native replies `voice.availability` with `forMessageId` and boolean `available`.
- Web → native: `voice.start` carries `requestId` and `locale`.
- Web → native: `voice.stop` finishes the matching utterance; `voice.cancel` aborts it.
- Native → web: `voice.event` carries `requestId`, state and bounded transcript text or an error code.

Start, stop and cancel are fire-and-forget; events are subscription broadcasts.
The availability probe uses a correlated request with the default five-second read deadline.
The native recogniser owns microphone capture and sends only text to the page.
Guidance output uses `speech`; recognition uses the separate `voice.probe` availability check.
See [On-device voice input](./voice-input.md) for the design and pending device qualification.

## Fixed origin

`config/mobileConfig.ts` validates the origin at build time. Release origins must
use HTTPS and pass its public-host checks. The official application identifier
`org.openmapx.app` is restricted to `https://openmapx.com` for both web and API.
There is no runtime server selector.

`App.tsx` applies a navigation allowlist, App-Bound Domains on iOS, disabled
WebView geolocation and denied media capture.
The microphone boundary applies to browser capture, not native voice search.
iOS denies capture with `mediaCapturePermissionGrantType="deny"`; the Android
WebView patch denies audio and video capture. The web shell microphone flag
remains false even when native voice input is available. Deep-link parsing reduces accepted
links to a map query or an active-navigation intent; parser support does not
establish end-to-end OS link delivery in the current app.

Self-hosted distributions need their own application identifier, scheme, signing,
associations, origin and trademark-compliant name.

## Authentication

Email/password, verification, email OTP and TOTP use the web UI and its session
cookie. OAuth and passkeys go through `auth.open`: the shell opens `/mobile-auth`
with `expo-web-browser` (a Custom Tab on Android, `ASWebAuthenticationSession`
on iOS). That page signs the user in inside the real browser when needed and
then hands back a callback code on the compiled scheme. The page's callback
scheme comes from `NEXT_PUBLIC_MOBILE_SCHEME` (default `openmapx`), so a
development build, whose scheme is `openmapx-dev`, completes the handoff only
against a web build configured with that scheme.

### The handoff, and its threat model

`SystemAuthSession.ts` generates a 32-byte PKCE verifier and a per-attempt state in
memory. It opens `/mobile-auth` on the compiled origin with the S256 challenge,
state and purpose. The callback uses the compiled scheme's `auth/callback` path
and contains a code and state. Development builds use a suffixed scheme such as
`openmapx-dev`.

The server stores a hash of the callback code. Codes expire after two minutes and
are consumed atomically; a well-formed but incorrect verifier also consumes the
attempt. The exchange uses
uniform rejection responses. An intercepted code cannot be redeemed without its
verifier; concurrent redemptions cannot both succeed.

The page receives the code, state and verifier through the bounded result,
exchanges them for a Better Auth one-time token, then verifies that token to set
the WebView cookie. Attempts remain in memory and are not retried after an
ambiguous exchange. Native session storage and diagnostic exports must exclude
the handoff material.

The web sign-in policy removes third-party primary sign-in on installed iOS;
OpenStreetMap and Mapillary are account-linking operations there. Test the
complete composed flow before making store claims.

## Content Security Policy

`apps/web/src/proxy.ts` supplies a per-request script nonce. The production
`script-src` excludes `unsafe-inline` and `unsafe-eval`; `strict-dynamic` allows
scripts loaded by trusted scripts. Inline styles remain allowed for runtime
styling. Image and connection origins remain broad enough for configured map and
data providers. These directives do not replace the bridge's document checks.

Inspect the served production headers and rendered page when changing CSP.
Source and policy tests alone do not prove a deployed browser enforced it.

## What is guaranteed offline, and what is not

Captured-route processing and storage tests exercise progress without network
access, with external location, audio and networking ports replaced by test
implementations. They do not establish installed background guidance because the
foreground command composition is missing. A complete OS callback blackout also
prevents real-time processing; foreground coasting does not create a background
wake source.

The remotely served UI has no guaranteed offline cold start. If no cached page is
available, native loading and recovery UI must remain usable. Physical-device
qualification must cover suspension, renderer loss, audio, alerts and recovery
before offline navigation claims are published.

## Back navigation

The system Back gesture steps out of what the user last opened, in the installed
PWA, a browser and the native shell alike. The web app records that in browser
history; `apps/web/src/lib/backNavigation.ts` is the only code that writes it.

- Opening a panel, place, list item or map tool pushes an entry. The navigation
  path that decides this (`navigationPath` in `lib/deepLink.ts`) leaves out the
  camera, base layer and overlays, so panning or toggling a layer rewrites the
  current entry instead.
- Closing rewrites the current entry, so a later Back cannot reopen what was
  just closed. Switching between siblings, such as another place in the same
  list, rewrites it too.
- App code never traverses history itself: to the Next.js router that popstate
  would cancel a page navigation in flight, such as a drawer link that also
  closes the drawer. A surface closed by its own control leaves its entry, and a
  Back that lands on an entry showing exactly what was already shown keeps
  going. The next surface to open reuses such an entry.
- Back restores only the open surfaces. The map stays where the user left it.
  When Back only steps out of something, the remaining surfaces keep their
  in-memory state instead of being rebuilt from the URL.
- Transient surfaces get an entry of their own through `useBackDismiss`:
  dialogs, menus and popovers (use the wrappers in `@/components/ui`, which lint
  requires), the drawer menu, the full-screen search, the photo gallery, the
  map-click card, an expanded bottom sheet (Back lowers it to the middle detent)
  and active guidance (Back ends the trip, like the End button).

Android's hardware Back reaches that history through `useHardwareBack` in the
native shell, which calls the WebView's `goBack()` while it can go back and
otherwise leaves Back to the system. iOS uses the WebView's own
back-forward swipe.

## What is not here

There is no EAS build configuration, hosted wrapper, remote push or native OTA
update channel in the release design. `ios/` and `android/` are ignored generated
projects. Change committed configuration, plugins or local modules, then
regenerate them. See [Mobile feasibility](./mobile-feasibility.md) for evidence
limits and [Mobile release](./mobile-release.md) for release blockers.

## Opening locations from other apps

Android registers `ACTION_VIEW` for the standard `geo:` scheme with `DEFAULT`
and `BROWSABLE` categories. After installing a rebuilt binary, OpenMapX is eligible
for the map app chooser when another app sends an implicit geo intent. A sender
that explicitly targets Google Maps bypasses the chooser; HTTPS links on Google's
domains remain Google's links.

The shell accepts coordinates (`geo:48.137,11.575?z=13`), labeled coordinate
queries (`geo:0,0?q=48.137,11.575(Marienplatz)`) and address searches
(`geo:0,0?q=Marienplatz+Munich`). Coordinates open a map pin without geocoding;
addresses open the search box for the user to choose a result. Links do not start
guidance or replace the compiled server origin. The latest request received while
a document loads is retained until that document completes bridge negotiation.
Both initial launch URLs and URLs received while the app is running are handled.

The PWA retains its `geo` and `web+maps` manifest protocol handlers for supporting
desktop browsers. Android Chrome does not register installed PWA protocol handlers
in the OS chooser. Its existing Web Share Target is an alternative for sharing text
or URLs, not a map chooser registration. See [Chrome's protocol handler documentation](https://developer.chrome.com/docs/web-platform/best-practices/url-protocol-handler)
and the [Android compatibility correction](https://github.com/mdn/browser-compat-data/issues/26107).
The native registration follows [Android's map intent contract](https://developer.android.com/guide/components/intents-common#Maps).
This change does not claim iOS default navigation app support or vendor-specific
navigation URI schemes.

## Live navigation surfaces

The installed app projects its committed ground or transit session into a bounded
native trip card, independently of WebView rendering. Foreground and headless
publication, recovery and teardown reconcile the same process-wide surface
controller. Its OS queue is separate from the navigation executor, so publishing
inside a committed effect cannot re-enter and deadlock session mutation. An OS
failure never prevents location/audio teardown or a durable session commit.

Android has a silent ongoing navigation card alongside Expo Location's mandatory
tracking indicator. The latter has a private, dynamically allocated ID; OpenMapX
does not overwrite it or replace the location service. Android 16 promotion is
requested through the platform compatibility extra, with an ordinary notification
fallback when the OS or user does not promote it. API 24/25 show a generic card
because those versions lack notification timeouts. Later versions expire the
trip card when its observation is stale. A user dismissal suppresses reposting
for that session; a freshness timeout allows restoration on fresh observations.

On iOS, a project-owned ActivityKit module renders a WidgetKit extension generated
from committed sources by `withNavigationSurfaces`. It starts only in foreground
and updates existing activities during location-driven background runtime. It
uses no push service, app group, shared database or additional background mode.
The encoded content is limited to 3,000 UTF-8 bytes, and combined static/dynamic
ActivityKit content is checked below 4 KB. A stale activity hides old guidance;
expiry can only end it at the next runtime opportunity. Force-quit survival and
continuous delivery without OS runtime are not promised. ActivityKit's finite
lifetime can require recreation on a later foreground opportunity.

SDK 57 builds opt in to Expo's single-window scene lifecycle through
`expo-build-properties` so binaries built with the iOS 27 SDK can launch.
Location input normalizes Core Location's fractional millisecond timestamps to
integer epoch milliseconds before ordering and persistence; otherwise a valid
iOS fix fails the durable session schema and quarantines the trip.

Both surfaces show bounded English/German instructions and session-selected units.
Ground progress uses the upcoming maneuver, not the step already performed.
Transit countdowns use captured departure/arrival times, expire at their target,
and never turn schedule-only confidence into a live position. Schedule-based
walk, wait and ride progress keeps its phase and stop guidance with an explicit
schedule label; it expires 60 seconds after the last progress observation or at
the captured event time, whichever comes first. Coasted fixes do
not renew GPS freshness. The ordinary update cadence is at most one per five
seconds; maneuver, session and health changes bypass the throttle. No geometry,
raw fix, refresh token or credential crosses into the surface payload.

Tapping a card reopens native navigation. End opens an identity-bound native
confirmation and requires unlocking/foregrounding the app. Only confirmation
calls `NavigationCoordinator.stopFromSurface`, through the shared session
executor and the same durable teardown used by the web command. Replayed links
from Recents or an old card cannot stop a replacement trip. The existing
`session.stopped` message also clears a matching web read model and releases the
shell's keep-awake state; older web versions may ignore the unsolicited message.

Lock-screen content follows system privacy settings. Android's private visibility
and generic public version do not override a user's decision to show sensitive
notification content. iOS marks the trip text privacy-sensitive, but physical
device verification remains necessary for user-specific redaction behavior.

For App Store distribution, register and provision the additional
`<app bundle identifier>.NavigationSurface` App ID. Its versions and signing team
follow the host application. Simulator builds and screenshots do not establish
physical-device background/force-quit behavior or App Store signing acceptance.

## Native sharing and geographic files

Android receives text/URI sharing and typed GPX, GeoJSON and KML attachments
through a dedicated, nonhistorical receiver activity. Document VIEW handles
`content:` grants, without BROWSABLE or storage/media permissions. The receiver
opens the React task first with a neutral MAIN intent without grants or URIs.
A separate MAIN delivery to the existing singleTask activity forwards only read
grants while background copying finishes; those grants do not enter the task’s
root intent. The task never retains the original share
intent, avoiding process-death replay even when Expo discards saved state.
Restored receiver activities and history launches are ignored. Cold and warm
intake does not depend on Expo or JavaScript startup; ordinary map/End Linking
ignores document URLs.

Android copies foreign providers into `noBackupFilesDir` while grants are valid.
It rejects `file:` URLs and positively identified own providers; package-visibility
lookup failure is not a refusal. Pipe-backed providers use nonblocking polling,
actual byte counts, cancellation and a ten-second deadline that closes descriptors.
Two workers and a bounded queue limit unresponsive provider work. Runtime extension
validation rejects unsupported/mixed attachments even if an explicit intent or
wildcard sender reaches the activity. Generic MIME fallbacks are not claimed;
provider MIME compatibility must be checked with the intended Files/mail app.

On iOS, `OpenMapXShareExtension` saves user-confirmed items into
`group.<appId>.intake`. It completes the extension request and asks the user to
open OpenMapX manually. It never launches the host through unsupported APIs.
Only the host and Share Extension have this group; the navigation widget has none.
The group contains intake bytes only, never authentication or navigation storage.
Files Open With requires `LSSupportsOpeningDocumentsInPlace=true`. For an OS-delivered
in-place URL, the host requires a positive security-scope grant, asynchronously
coordinates the read and copies at most 5 MiB into owned staging within a ten-second
deadline. Scope is acquired on the worker and released on success, failure, timeout
or background-task expiration. The provider's original is never edited or deleted;
no bookmark or grant is retained. The descriptor is opened without following
symlinks or blocking on FIFOs, checked with `fstat`, and rejected if its resolved
path is in the app's data container or intake App Group. The private inbox commit
runs after the external accessor exits.

For non-in-place OS copies, only regular, non-symlink direct children of
`Documents/Inbox` are accepted; the temporary OS copy is removed after handling, and abandoned
copies expire on launch. `UIFileSharingEnabled` and `UISupportsDocumentBrowser`
stay absent. Opening a selected external document does not expose the app container
in Files. RN Linking never grants file access.

Android document channels reset only on the vendor-tagged native `onPageStarted`
event. History callbacks still update navigation/back state, but cannot reset the
bridge even when Chromium reports `loading=true` after a finish. A missing tag in
a stale development APK fails closed. Native load-end handling is idempotent,
failed loads retain their error state, and bridge requests always have production
deadlines. The per-document nonce remains main-frame-only. Fast consecutive real
loads can still race nonce-prop delivery; iOS policy starts can include a fragment
or a navigation that never commits. These are separate qualification limits, not
reasons to accept an old channel or fall back to browser navigation.

The Foundation store coordinates short commits across the host and extension.
External provider reads do not hold the coordinator lock. Staging is separated by
writer and named with a writer-recorded epoch; cleanup waits beyond the copy
deadline plus a minute, preserving a live writer. Host document commits have a
background-task assertion. The host module and extension include file-access
privacy manifests. Their [required-reason declarations](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype)
cover app/group metadata (`C617.1`), selected-file metadata (`3B52.1`) and monotonic
deadline timers (`35F9.1`). No uptime or metadata is transmitted. The extension imports GPX `com.topografix.gpx`, KML
`com.google.earth.kml`, and Apple's `public.geojson` (also declared for older OS
versions). Its bounded SUBQUERY activation predicate excludes arbitrary file URLs.
URL and text attachments are combined into one editable location, retaining
labels and the first link; irrelevant preview attachments are ignored in this
mode. Geographic files must all be supported. Apple declares `public.geojson`
on iOS 18 and later; its imported declaration supports older OS versions, whose
installation and Files registration still require device qualification.

Limits are 4,096 UTF-16 units/8 KiB for text, 5 MiB per file, five files per share,
and eight content items/20 MiB for the owned inbox. Two bounded error descriptors
remain available when content is full. Multi-file copies commit individually: if
a later attachment fails, earlier successful entries remain alongside an error
notice. Items expire after 24 hours. Names are
bounded display labels; only opaque UUIDs address immutable entries. Protocol-4
list/read/complete commands transfer stateless 24 KiB chunks through the existing
origin/nonce-authenticated bridge. No native path, sender URI or server authority
crosses it. Reads never acknowledge an item; explicit Open/Import or Discard does.
Older pages receive a native update notice and preserve their pending items.

The web preview validates UTF-8 and exact chunk boundaries with a 60-second total
transfer limit. Text is classified locally; short URLs are never fetched. Users
can edit an unsupported link into an address. Geographic parsing rejects XML
entities/DOCTYPE before DOMParser, invalid/out-of-range geometry and oversized or
deep collections. It permits at most 100,000 positions and 10,000 features.
KML description/icon/style URL metadata is dropped. Browser `.json` import remains
supported; native document registration is limited to `.gpx`, `.geojson`, `.kml`.

The inbox entry point returns non-map pages to the map before offering preview.
A route change cancels pending application. Confirmation applies a map search
or the existing imported overlay. It never adds
saved places automatically. Replacing an overlay is explicit. A fresh native
inbox listing supplies navigation availability immediately before application,
and the page rechecks its native session and pending mutations synchronously.
Preparing, active, arrived or unresolved navigation defers application. Intake
never terminates or replaces a trip; Later keeps the item and Discard removes only
that item.

Platform references: [Expo incoming sharing](https://docs.expo.dev/versions/v57.0.0/sdk/sharing/)
labels its iOS host-launch approach experimental and unsupported by Apple;
[Apple's extension guide](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html)
documents App Groups and activation predicates; the
[Android receiver guide](https://developer.android.com/develop/ui/compose/sharing/receive)
and [ContentResolver security guidance](https://developer.android.com/privacy-and-security/risks/content-resolver)
define the Android receiving and provider authority boundaries.
[Apple’s GeoJSON type](https://developer.apple.com/documentation/uniformtypeidentifiers/uttype-swift.struct/geojson)
confirms the `public.geojson` identifier.
