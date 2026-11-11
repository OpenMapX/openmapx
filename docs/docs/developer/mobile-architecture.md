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
into `createShellBridge`. The composition's `dispatch` sends navigation commands
to the `NavigationCoordinator`'s serial queue. It answers the one-shot location,
settings and sign-in requests (`bridge/answerCommand.ts`) through the shell
services beside that queue, because each can wait on the user for as long as a
prompt or a browser is open, and location batches must not wait with it. The
permission flow of `session.start` stays in the queue, because it guards the
prepared session. Permission prompts are serialized with each other beside the queue
(`permissions/permissionPromptLock.ts`): the start flow, a one-shot location
request and voice search's microphone prompt each wait for a prompt already
showing, because Android rejects a permission request while another is open. A command nothing handles receives `unsupported-capability`. The handshake reports ground and transit
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
| Ground session rules (cue timing, reroute guards, speed limit, coast) | Shared `groundSessionPolicy`              | Shared `groundSessionPolicy`                                                                                    |
| Closure reroutes and faster-route offers                              | Browser engine                            | Not provided                                                                                                    |
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
only when the OS starts the task without the app. It is composed once per
process by `createInvisibleNavigation`, the same factory over the same device
ports (location driver and its Android background rule, audio, alerts,
reroute and refresh, connectivity), with nothing sent to a page, no prompts
and no keep-awake. An off-route driver in an OS-started process therefore gets
a reroute, and the background task waits for that request
(`settleRemoteWork`) before it reports the batch handled. When the visible
app's composition registers, the headless one is disposed. A transit commit
in that process reconciles the scheduled get-off alerts there, reading the
notification grant through the same port.

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
- **Location profiles.** Each phase asks for a cadence (`location/profiles.ts`).
  On Android every profile has no distance filter, so updates arrive on the
  time interval even while the user stands still. iOS keeps its distance
  filters, because it ignores the time interval. Changing a profile restarts
  the stream, and restarting it starts the location foreground service.
  Android 12 and later forbid starting a foreground service from the
  background, and expo-location enforces this on every Android version: it
  throws `ForegroundServiceStartNotAllowedException` unless its activity is in
  the foreground, and a locked screen or a headless process does not count. The
  stream would then already be stopped. On Android the shared driver
  (`location/backgroundSafeDriver.ts`) therefore never restarts a running
  stream while the app is not active. It asks inside the driver's serialized
  step, immediately before the stop, so a screen that locks while the change
  waits is respected. Nothing is held in memory: a runtime the system starts
  for one background batch is torn down seconds later. When the app becomes
  active on Android, including a cold open where it is already active as the
  foreground coordinator starts, the coordinator derives the cadence again from
  the committed session (`refreshLocationProfile`) and applies it to a running
  stream. iOS changes profiles at any time, so it needs no refresh.
- **Storage.** expo-sqlite runs each exclusive transaction on its own
  connection, so `getDatabase` queues writes on the one handle and sets a busy
  timeout. Without the queue a diagnostic write and a batch commit collide with
  "database is locked".
- **Shared ground rules.** The rules a road session wraps around the engine
  live in `packages/core/src/navigation/groundSessionPolicy.ts`, which the
  browser engine (`useNavigationEngine.ts`) imports too: cue timing for the
  voice-timing setting (1.5, 1 and 0.6 times the trigger distances), the
  reroute guards, the speed limit shown (driving and motorcycle, never walking
  or cycling: the route's segment limit, then the limit matched for the
  journey, then the step's), coasting,
  and which route of a directions answer a reroute follows (the one the server
  marked active). One difference is the shells' own: after a connection
  failure the browser waits for the user's retry, which skips the failure
  delay, while the native session asks again by itself once the connection is
  confirmed.
- **Reroute.** When the engine asks for a reroute, the guards decide whether
  one is sent: one request at a time, nothing while the session is offline, a
  30 s pause after three successful reroutes within two minutes, and a delay
  after each failure (3, 6, 12, 24, then 30 s, repeating). A request whose
  answer never came back, because its process died or its composition was
  disposed, stops counting as open 20 s after it was sent. Each wait is also
  bounded by its own length, so a clock set backwards cannot stretch it. A
  refused reroute is withheld rather than spent (`withheldReroute`): the
  engine keeps its score and does not grow its own backoff, so it asks again
  on the next off-route fix and the reroute is sent as soon as the guard
  allows. A reroute held back while offline
  is asked for as soon as the connection is confirmed again. A `reroute`
  effect only starts the request (`createRemoteWork.ts`). The answer re-enters
  the coordinator as a queued `applyReroute`, which applies it only while the
  session and its request id still match.
- **Coasting.** While the app is visible and no fix arrives, the composition's
  `GroundCoastingScheduler` estimates the position along the route from the
  last real fix, starting 3 s after it and slowing to a stop over two minutes
  and at most 3 km. Once a second the estimate enters the coordinator's queue
  like a batch (`handleCoastedFix`) and is dropped if the session has moved on
  from that fix. An estimate never replaces the last accepted fix or the
  persisted anchor (`coastingAnchor`), so every estimate starts from a real
  position, and the next real fix ends the coast. There is no coasting off
  route, during a reroute, after an arrival or an end, or while the app is
  out of sight.
- **Settings.** `settings.update` changes the running session: voice guidance,
  keep-screen-on, voice timing (ground) and alight alerts (transit), plus locale
  and units. Only the session identity is checked, not the revision, because
  every field is an absolute value and progress commits about once a second.
  Muting cuts off a prompt that is already playing. The page sends the user's
  voice timing in the start package and sends a change made during the trip.
- **Arrival.** The arrival commit keeps the session row for the page and
  releases the location stream and its foreground service after a release
  window (`navigation/arrival.ts`). Every arrival keeps the stream for
  `ARRIVAL_CUE_GRACE_MS` (10 s), so iOS does not suspend a backgrounded app
  before the arrival announcement plays. A transit arrival keeps it until the
  last rider confirmation can no longer be undone, if that is later, so an undo
  resumes a tracked trip. Neither a road nor a transit arrival changes the
  profile, so nothing restarts the stream. A coordinator timer releases the stream where
  JavaScript timers run: in the foreground, and on iOS while background
  location keeps the app running. Android pauses a backgrounded app's timers
  even under a foreground service. There the first batch after the window
  releases the stream, and the time-driven Android profiles guarantee that
  batch while the user stands still. A batch also releases the stream after a
  process restart. The window governs location only. The arrival itself, and
  the page's arrival card, last until the page completes it ("Done") or the
  session reaches its lifetime, whatever the app's visibility. Opening the app
  runs recovery, which asks the coordinator (`closeFinishedSession`). Inside
  the window, the coordinator keeps the arrival and its undo and schedules the
  release in the current process. Past the window, it releases location and
  the trip surface now and keeps the row.
- **Session end.** Every end goes through one coordinator method: End or
  arrival completion from the page, End on the trip card or the recovery
  screen, a car trip replacing the current one, a refused permission or a
  driver that could not start, and expiry. A new `session.prepare` also ends
  a preparation that was never started, because the page that made it may
  have reloaded; the latest intent wins, and a late start for the old one is
  refused with `revision-conflict`. Such an end sends the page no notice,
  since nothing was guided. A car start ends an unstarted phone preparation
  the same way, but tells the page with `session.stopped`, because the phone
  page may still be showing it. A running trip still refuses a new prepare
  with `session-active`, and a car start unless the car names that trip. Every end removes the session row, runs
  the device effects (location, audio, alerts, surface, a final snapshot) and
  then notifies each consumer once. The page hears the end as the reply to its
  own command, or, when native ended the trip, as one unsolicited
  `session.stopped`, never both. A page that is not loaded learns it from the
  next handshake, which reports no active session. The composition's
  `onSessionEnded` tells the shell, which clears guidance and any recovery
  screen, and keep-awake releases the screen. Guidance starting, or stopping
  at an arrival, is derived from the committed row after each publish and
  reported once per change. When recovery leaves an active session untracked
  (Resume or permission lost), no publish reports guidance as running until
  the user resumes or the session ends, so a connectivity change or a late
  reroute or refresh answer cannot clear that screen. Recovery (`NavigationRecoveryController`) is part
  of the composition. It inspects the session on every visibility change, but
  it ends a session only through the coordinator, between its own steps on
  the shared executor. It ends a session past its lifetime and a preparation
  the page never started. A preparation is left alone for five minutes, because
  between prepare and start the page may show a system prompt of its own (the
  heading permission), which takes the app's focus. It never ends an arrival.
- **Keep-awake.** The composition holds the screen only while the app is
  visible, the location stream runs for an active session, and that session's
  keep-screen-on setting is on. It is the only holder of the wake lock. It
  re-checks, together with coasting, after every published change, after every
  session end and when the shell reports a visibility change or a recovery
  outcome (`reviewForegroundWork`), so a setting change, arrival or end
  releases the screen with the commit itself.
- **Speech interruptions.** A call or another source that takes audio focus
  during a cue stops it, and later cues are not queued behind the interruption.
  iOS observes the end of an audio-session interruption. Android abandons its
  focus request on loss, so no end is delivered; each later cue requests focus
  again instead. During a call Android usually denies that request and the cue
  is skipped. Against another app's transient focus, such as a voice assistant
  or another navigation prompt, the request is usually granted and the cue
  speaks.
- **Connectivity.** The composition follows NetInfo through
  `connectivity/ConfirmedConnectivity.ts`. A reading counts once it has held
  for 3 s, so a tunnel or a cell handover that flaps for a second changes
  nothing. A timer confirms a reading that holds. Android pauses a backgrounded
  app's timers, so each location batch also checks the reading against the
  clock. The coordinator commits a confirmed change to the active session
  (`connectivityChanged`) and publishes a full snapshot. While a session is
  offline, reroutes and itinerary refreshes are not attempted, so a rider
  underground keeps the one-time refresh token. When the network returns, the
  processors ask at once for a reroute the outage held back or a refresh that
  fell due. An `unknown` reading leaves the committed state alone. A request
  already in flight when the network drops still counts as an ambiguous
  attempt, because the server may have spent the token; such a token is
  replayed only within the server's 120 s replay window.
- **Transit refresh.** A refresh effect starts the request off the queue and
  the answer re-enters as a queued `applyTransitRefresh`, like a reroute.
  Unlike a reroute, a refresh is never abandoned, not even when its
  composition is disposed (for example when the visible app takes over from a
  headless process): the server may already have spent the one-time token,
  and only the answer carries its replacement. The 15 s request timeout
  bounds it.
  Replanning a missed connection is not wired; the session keeps running on its
  itinerary.

## Android Auto surface and runtime

The native car surface is a deliberate, narrow exception to the rule that map
rendering belongs to the phone WebView. It is still web map rendering: the car
service owns a second WebView inside a Presentation on a VirtualDisplay supplied
with the host surface. It loads the map-only `/car` page. Directions, lanes and
arrival estimates use Android for Cars templates rather than phone web chrome.
The headless navigation bundle does not import the web renderer or MapLibre GL JS.

`OpenMapXCarRuntime` runs through the application's existing ReactHost without
requiring the phone Activity. It reuses the foreground coordinator when present,
or composes its own with `createInvisibleNavigation`, over the same executor,
SQLite repository and device ports. Committed snapshots fan out independently to phone and car; the car
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

Both sides speak exactly one version, **v6**. The constants in
`packages/core/src/navigation/mobileProtocol.ts` and the release descriptor in
`apps/mobile/release/version.json` agree on `min: 6, max: 6`. Every message shape
change raises both bounds, because a build speaking an earlier shape cannot parse
the new one. A page and an installed app built for different versions negotiate
no version: the shell still answers the hello with a null selection, navigation
stays disabled and the page asks for an app update. Protocol negotiation alone
does not establish that a command is implemented.

Bridge requests use runtime timers by default. Preparation has a 15-second budget
and ordinary reads have a five-second budget. Start's web request budget is ten
minutes plus 15 seconds to accommodate permission screens and a settings round
trip; a person can still keep native permission UI open longer. A start timeout
requests a fresh snapshot without delaying the reported failure. The deadline
does not cancel the native operation, and an authoritative snapshot can still
show the trip as active later. A timed-out initial handshake requires a page
reload to negotiate again.

A correlated `native.error` rejects the page's request with a
`NativeCommandError` that carries the shell's code; it never resolves as the
reply the command expected. A refusal that arrives after the page's deadline
finds no pending request and is ignored. A reply that fails the page's schema
fails its request at once with `invalid-response` instead of leaving it to its
deadline; the page logs the message type, never its payload, once per type. The navigation commands treat
`no-session` as done for End and for a settings change, because there is
nothing left to end and the next start reads the stored preference. Every
other refusal fails the command. A failed End asks for a fresh snapshot and
shows a notice, a fresh one for each failure. A refusal says navigation is
still running. No answer (a timeout or a lost channel) says the end could not
be confirmed and asks the user to check the trip, because native may have
ended it. A stop that
names no session, sent when there is none, is answered with `no-session`.

Every native send reports `sent`, `queued`, `dropped` or `invalid`. Its
payload is typed by the message type it names (`NativeToWebPayload`), so a
wrong payload does not compile; the bridge adds the id of the command a reply
answers. The page's fire-and-forget `send` is typed the same way
(`WebToNativePayload`); its correlated `request` is checked against the same
schema at run time. A message that fails its schema is not sent; the bridge
records its type (never its payload) as a `typed.error` diagnostic. A
correlated reply that fails its schema is followed by `native.error` with
`internal-error`, so the page gets an answer instead of waiting out its
deadline.

### Rollout order

A protocol change ships the web build and the installed app together: an
installed app whose version does not match the page shows the update prompt until
it is replaced. Queued navigation
messages are stamped only after negotiation. Pending inbox items survive until a
compatible page opens them, the user discards them, or their 24-hour expiry.

Voice input uses a correlated `voice.probe` / `voice.availability` exchange after
negotiation. iOS and Android below API 33 answer unavailable.

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

Snapshots follow the shared contract in
`packages/core/src/navigation/nativeSnapshot.ts`. The native builders are typed
from its produced schemas, which are complete and strict, so a renamed field
fails to compile and a field that must not reach the page fails their tests.
The page accepts a snapshot through its wire schema. That schema requires only
what places a snapshot (its type, session, revision and route or itinerary
fingerprint), checks the type of each value it names and lets unknown fields
and unknown values through, because the app and a self-hosted page update
independently: an older page must not refuse every snapshot of a newer app. A
request answered when there is no session carries an empty snapshot.

A full snapshot can rehydrate the page at the current revision. A progress delta
is absolute: it carries the current position, status and health values read
from the committed session, not a difference from the last delta. The route,
itinerary and settings change only in commits that publish a full snapshot. The
shell throttles progress to one delta a second and drops the ones
in between, so the page applies any newer delta for its session and route or
itinerary, even after a revision gap. A delta for another session or route asks
for a full snapshot, and an older one is ignored. The values a delta may move
are derived from the produced progress schemas (`NATIVE_SNAPSHOT_HOT_FIELDS`).

There is no separate event message: everything the page shows, an arrival or an
off-route episode included, comes from snapshots.

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

Email/password, verification, email-code password reset and TOTP use the web UI and its session
cookie. OAuth and passkeys go through `auth.open`: the shell opens `/mobile-auth`
with `expo-web-browser` (a Custom Tab on Android, `ASWebAuthenticationSession`
on iOS). That page signs the user in inside the real browser when needed and
then hands back a callback code on `/mobile-auth/callback` of its own origin, a
verified link: an Android App Link or an iOS Universal Link. The custom scheme
still carries map and navigation deep links, but never the sign-in callback.

The verified callback needs an HTTPS origin whose association files name the
build's application identifier and signing identity (see
[Store operations](./mobile-store-operations.md#verified-links)). On iOS it
requires 17.4 or later, where `ASWebAuthenticationSession` can match an HTTPS
callback. On earlier versions the shell does not open a browser and answers
`auth.result` with `unsupported` instead of falling back to a custom scheme; the
sign-in dialog then explains that the device needs iOS 17.4 or later and turns
off provider and passkey sign-in, leaving email and password. The deployment
target stays at iOS 16.4. The deployment's well-known service lists the
allowed app identifiers; development builds use `org.openmapx.app.dev` and their
own signing certificate, so they complete the handoff only when the operator
also lists that identifier (and, on Android, its fingerprint). A development
build against a plain-HTTP origin, or without an Apple Team ID, cannot complete
the handoff at all. When the OS does not take the link over, the browser shows
the callback page, which asks the user to return to the app.

### The handoff, and its threat model

`SystemAuthSession.ts` generates a 32-byte PKCE verifier and a per-attempt state in
memory. It opens `/mobile-auth` on the compiled origin with the S256 challenge,
state and purpose. The callback is `/mobile-auth/callback` on the same compiled
origin and contains a code and state; the shell accepts it only from that exact
origin and path. With a verified link, the OS routes the callback to the app the
origin's association files name, instead of to any app that registered the same
custom scheme. That guarantee covers routing only. Another app on the device can
still open `/mobile-auth` in its own browser session with its own PKCE verifier
and receive its own callback; the consent page, which states the purpose, and
the user's explicit tap on "Continue to the app" are what stand against that.
The deep-link parser refuses `/mobile-auth/*`, so the callback never loads in the
WebView.

The server stores a hash of the callback code. Codes expire after two minutes and
are consumed atomically; a well-formed but incorrect verifier also consumes the
attempt. The exchange uses
uniform rejection responses. `POST /api/mobile-auth/issue` and
`/api/mobile-auth/exchange` accept only requests whose `Origin` is one of the
deployment's trusted web origins (`CORS_ORIGIN`); there is no separate mobile
origin setting. A native client can forge
`Origin`, so this check keeps browsers on other sites out; it does not
authenticate the app. An intercepted code cannot be redeemed without its
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
implementations. `foregroundNavigation.harness.test.ts` runs the shipped
`createForegroundNavigation` composition on a fake phone
(`navigation/testing/foregroundHarness.ts`): only location, audio, notifications,
storage, network, connectivity and clock are replaced, through the
composition's `device` option. That covers the wiring between page commands,
location batches, the durable session and device effects, including a process
restart, recovery on a visibility change, and a process the OS starts for a
location batch (`relaunchHeadless`), which composes the headless navigation
over the same fake ports. Its scenarios include coasting through a gap in
delivery, the reroute guards and a preparation surviving a focus change. It
does not establish OS delivery, background execution or audio behaviour on a
device. A
complete OS callback blackout also prevents real-time processing; foreground
coasting does not create a background wake source.

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
calls `NavigationCoordinator.stopNatively`, through the shared session
executor and the same terminal path as the web command. Replayed links from
Recents or an old card cannot stop a replacement trip. The unsolicited
`session.stopped` that path sends clears a matching web read model; older web
versions may ignore it. Keep-awake is released by the same end notification.

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

The ten-second budget starts when the OS delivers a URL and includes waiting on
the serial host queue, so an item behind a slow provider can expire before reading.
A cancellation racing the final private rename can leave a completed inbox item
alongside an unreadable notice; the immutable item remains available for review.

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
URL and text attachments are combined into one editable item. Repeated lines and
blank lines inside each text value are preserved; only identical attachment
values are deduplicated; irrelevant preview attachments are ignored in this
mode. Geographic files must all be supported. Apple declares `public.geojson`
on iOS 18 and later; its imported declaration supports older OS versions, whose
installation and Files registration still require device qualification.

### Shared travel plans

German DB Navigator connection text is recognized before generic location search.
The source-adapter registry in `packages/core/src/travel-plans/index.ts` is pure:
new sharing apps implement `TravelPlanAdapter` and produce `SharedTravelPlan`;
they do not change the native protocol or implement their own transit resolver.
The DB adapter accepts an optional route header, explicit weekday/date/year,
service, optional headsign, and ordered `Ab`/`An` station/time lines. Overnight
calendar dates are inferred. Walking blocks, missing years, DST-discontinuous
wall times, cross-offset travel and day-long transfers are unsupported. A DB
booking link alone requests the full text; it is never fetched.

Only confirmation triggers acquisition through the configured OpenMapX API client.
Station search supplies geographic anchors, corroborated by nearby baseline rail
stops. Unrelated partial global discovery is not train identity evidence. Complete,
non-stale anchored departure and vehicle-journey responses must confirm every
operational train number and both scheduled stop times. Failures, ambiguity and
cancellation retain the share; cancellation of a **train** is displayed on the
verified trip rather than replaced by another train. Current platform/delay
changes do not change identity. The resolver bounds station records/candidate
journeys and has a 60-second cancelable deadline. Exact availability depends on
the enabled sources and their timetable horizon; historical trains can be absent.

`GET /api/integrations/transit/stops/:id/departures?time=<UTC ISO>&minutes=60`
selects the explicit optional provider method `getDeparturesAt`; current-only
providers return 501 rather than ignoring the anchor. Anchored requests have
separate cache keys and `no-store` response headers. MOTIS local/hosted support
this through their existing transport/source policy. No new upstream is added.
OpenAPI generation was rerun; this route remains inventory-only, so adding the
query parameter does not change its generated operation entry.

The resolver first asks the configured provider for an ordinary plan and matches
its whole transit sequence against verified trip IDs, stop IDs and scheduled
instants. A bounded paging probe can discover a candidate, but only a fresh
unpaged response seeds the ordinary search cache. If search omits that train,
`POST /api/integrations/transit/plan/resolve` accepts bounded provider references.
The server binds them to a healthy permitted source and its dataset epoch, derives
native coordinates and flags from provider trips, and uses MOTIS structured
reconstruction. Raw substituted, merged or dummy legs are rejected before the
ordinary itinerary normalizer runs. Hosted endpoint support is detected at runtime;
an unsupported source or missing timetable fails without selecting an alternative.
Successful reconstruction acquisition is cached for 30 seconds; policy, health
and epoch are checked on every request and one-time refresh handles stay separate.

The complete provider envelope is retained: displayed names, delays, platforms,
geometry, transfers, fares and alerts come from the provider, never from the share.
Native reconstruction currently omits fares when the upstream omits them. It uses
a separate reference-query key; refetch and signed live refresh resolve that same
reference and never fall back to the first ordinary search result. Ordinary plans
keep their existing paging and refresh behavior.

A generic one-shot selection handoff seeds the truthful query cache, publishes
provider-derived route inputs and selects the matching stable itinerary key after
normal ranking. It opens the existing directions details without an import banner
or a separate travel UI. Route edits release the reference. Mandatory accessibility
and bike requirements and persisted hill preferences are preserved; session filters
use the ordinary neutral defaults. A current mandatory bike-carriage session is
retained with an explanation before acquisition: walking access cannot hide or
drop that requirement. Raw/debounced query-key fencing prevents a
mounted panel from publishing a previous search, and a late location fix only fills
the same still-empty origin waypoint. Native authority, document lifetime, selected
item and cancellation are rechecked before publication; failed acknowledgement
leaves the owned item for retry.

Limits are 4,096 UTF-16 units/8 KiB for text, 5 MiB per file, five files per share,
and eight content items/20 MiB for the owned inbox. Two bounded error descriptors
remain available when content is full. Multi-file copies commit individually: if
a later attachment fails, earlier successful entries remain alongside an error
notice. Items expire after 24 hours. Names are
bounded display labels; only opaque UUIDs address immutable entries. List/read/complete commands transfer stateless 24 KiB chunks through the existing
origin/nonce-authenticated bridge. No native path, sender URI or server authority
crosses it. Reads never acknowledge an item; explicit Open/Import or Discard does.

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

Intake resolves supported Apple unified and Google long map links locally without
following short-link redirects. When native trip authority is unavailable, it
fails closed with reopen/recheck guidance and keeps shared items. This differs
from a known active trip, which remains deferred until navigation ends. The
development feasibility mode intentionally omits normal navigation composition
and allows intake.
