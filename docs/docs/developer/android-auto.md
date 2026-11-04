---
title: Android Auto
description: Car templates, the service-owned map surface, navigation authority and Desktop Head Unit testing.
sidebar_position: 12
---

# Android Auto

OpenMapX has an Android Auto implementation for ground navigation in the installed
Android shell. This page describes the source implementation, not a qualified
store release. Real head-unit qualification and Google Play review remain release
gates. Store metadata must not claim Android Auto support until both are complete.

This is phone-projected Android Auto only. Android Automotive OS (AAOS) is not
implemented. CarPlay remains blocked on Apple's entitlement and is outside this
implementation; Android Auto work does not establish CarPlay support.

## Templates and the map surface

Google's [car app quality rule NF-2](https://developer.android.com/docs/quality-guidelines/car-app-quality),
checked **4 November 2026**, states:

> The app draws only map content on the surface of the navigation templates.

The rest of NF-2 assigns text directions, lanes and arrival estimates to template
components, while allowing driving information such as speed limits and road
obstructions in the safe map area. OpenMapX follows that split:

- `NavigationTemplate`, `RoutingInfo`, `Step`, `Maneuver`, `Lane` and
  `TravelEstimate` carry the turn instruction, distance to the maneuver, lane
  guidance and remaining distance/time/ETA. Rerouting uses loading metadata
  without ending navigation. `NavigationManager.updateTrip` supplies next-turn
  metadata for cluster/HUD consumers; this is not a separately rendered cluster map.
- The map surface draws the map, route, puck, traffic and road-condition overlays,
  current speed, speed limit and attribution. It reuses `MapCanvas`, navigation
  route layers and `useNavCamera`. It does not mount the phone's maneuver banner,
  lanes, ETA panel, bottom bar, search, dialogs or sheets.
- Destination lists, search, preview and Start belong to host templates.
  `SearchTemplate` handles search; `MapWithContentTemplate` with `ListTemplate`
  handles preview. The map action strip carries pan, zoom in/out and, during a
  trip, route overview or (when the map no longer follows) recenter; zoom also
  appears on the preview. These and the Destinations action are persistent, so
  they do not hide after the host's ten-second idle timeout. Surface DOM ignores
  pointer input; host gestures become camera commands.
- Layout follows Google Maps on Android Auto: current speed sits bottom right
  beside the speed-limit sign, next to the map controls, and is hidden while a
  route is chosen. Road shields scale with their sign image (1.6×) rather than
  with the 24 px car label size, because shield images are fixed per reference
  length.
- Turn arrows and lanes match the phone exactly. `@openmapx/core` decides the glyph
  (`maneuverIconName`) and the lane cells (`presentGuidanceLanes`: which lanes
  light up, which arrow is recommended, unmarked-lane fallback, shared stems) for
  both the phone's banner and the car. The projection sends glyph names; the car
  draws the same Material icon paths (vector drawables copied from
  `@mui/icons-material`, MIT; Material Icons, Apache-2.0) in the banner's style:
  usable lanes on a light tile, recommended arrow white, others at 60 % or 35 %.
  Like the phone, lanes appear only within `guidanceApproachMeters` of the turn.
  The car uses the step's sign as lane evidence but not the phone's per-lane OSM
  destinations, which the web fetches separately. The host renders no maneuver
  icon of its own, so these bitmaps also feed the cluster and the notification.
- Distances use the phone banner's rounding (`measurementDistanceParts`: whole
  metres, one decimal below 10 km, feet below a mile). The projection sends the
  rounded value and unit; the car wraps them as the host's `Distance`, which shows
  miles with at most one decimal. The trip's navigation card uses the same rule.
- Without a trip, a native position feed (`car-position`, fused provider, 1 s)
  places a location dot and follows the car at street zoom; it stops while a
  trip runs, because trip snapshots carry their own position. Fixes go to the
  car surface only and are not stored.

`CarSurfaceHost.kt` receives the host's `SurfaceContainer`, creates a
`VirtualDisplay` with its surface, dimensions and density, and shows a
hardware-accelerated `Presentation` containing an `android.webkit.WebView`.
The WebView loads `/car` on the compiled web origin. It is a second,
service-owned map WebView, not a capture of the phone screen. This follows the
View-hosting pattern in Google's [Draw maps guide](https://developer.android.com/training/cars/apps/library/draw-maps);
it does not establish reliable WebGL rendering on every supported phone or host.

The native host restricts page navigation and the `OpenMapXCar` message listener
to the compiled origin and main frame. File/content access, mixed content,
geolocation and permission prompts are denied. The `/car` entry uses minimal
query/theme providers and public integration metadata, without phone auth or PWA
services or community frontend extensions. In an ordinary browser without the
native bridge it shows an inert waiting page. A development-only
`/car?carPreview=1` harness supplies synthetic route/viewport messages; its public
OpenMapX endpoints and browser screenshots do not qualify Android Auto.

### Day/night and responsive geometry

`CarContext.isDarkMode` controls the car appearance. Configuration changes send a
new viewport and invalidate the template; the phone theme does not choose it.

Surface dimensions, stable/visible rectangles and gestures are converted to CSS
pixels using `dpi / 160`. Insets are distances from each surface edge, not rectangle
coordinates. Both rectangles are sent and validated; the **stable** safe area
currently governs persistent overlays and camera padding. Visible-area updates
are retained but do not independently reposition overlays. The full surface
remains the map viewport.

A safe width below 500 CSS pixels or height below 300 selects compact framing,
reducing forward offset and maximum pitch from 55 to 25 degrees. Preview fitting
clears the follow camera's padding before fitting into the safe area. Credits wrap
and their measured height offsets the speed panel; overlays keep clear of the map
control column even when the host leaves it inside the stable area. Actual host callback geometry and WebView density identity still need DHU
verification; synthetic wide, narrow, short and tall fixtures are not universal
host split-screen dimensions.

## One navigation authority

The relevant owners are:

| Source                                               | Responsibility                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `apps/mobile/modules/openmapx-android-auto`          | Car service/session, templates, surface, command mailbox, trip mapping and notifications       |
| `apps/mobile/src/car`                                | Runtime composition, commands, route planning, committed snapshot publication and debug replay |
| `apps/web/src/app/car`                               | Passive map rendering and snapshot reconciliation                                              |
| `packages/core/src/navigation/carSurfaceProtocol.ts` | Versioned surface message schemas and bounds                                                   |
| `packages/core/src/navigation/mobileProtocol.ts`     | Phone bridge, including optional destinations capability                                       |
| `apps/mobile/plugins/carConfigTransforms.ts`         | Compiled web origin, permissions and phone Activity navigation-intent filters                  |

`CarRuntimeService` starts the registered `OpenMapXCarRuntime` headless task through
React Native's `HeadlessJsTaskService`. It uses the application's existing
`ReactHost` in the same Android process, without a second Hermes engine or phone
WebView. `carRuntime.ts` reuses the registered foreground coordinator when present;
otherwise it composes the shared coordinator core with real reroute and audio
ports. It disposes that car composition on phone takeover or detach. It does not
rely on the location-only headless composition's no-op remote ports.

Phone commands, car commands and location batches enter the shared executor and
SQLite repository. Kotlin and the car page do not run another navigation engine.
`createPublishPort` fans committed state out to phone and car independently;
phone delivery failure does not determine car state. Car attach, immediate
changes and route fingerprint changes publish full snapshots. Ordinary progress
omits geometry and is coalesced to one update per second; lower revisions are
dropped. Terminal publication reads the durable acknowledgment and clears the
car projection. The car page uses the phone snapshot reducer/store path; a gap
requests a full snapshot through `car-error: snapshot-gap` and native `attach`.
Rendering snapshots never replay speech cues.

The native mailbox retains commands until JS acknowledgment. The template has no
Stop action of its own: Android Auto draws an end-trip button on the arrival card
and reports it, like a host takeover, through
`NavigationManagerCallback.onStopNavigation`, which sends `stop` through
`CarSessionAdapter` to the shared coordinator. That path cancels pending car
planning/replay and stops the shared trip, including its guidance effects.
Ordinary detach cancels car work and releases rendering/runtime resources without
issuing `session.stop`; disconnect is distinct from host navigation takeover.

Renderer-process loss and style/WebGL failures trigger at most three delayed
surface recreation attempts with fixed-code logging. Surface destruction releases
the WebView, Presentation and display. Lock, reconnect and process recovery still
need installed-device acceptance; the existence of recovery code is not proof of
those outcomes.

### Destinations, planning and start policy

The phone page publishes `destinations.update` only after protocol v3 negotiation
reports the optional `carDestinations` capability. The schema permits at most 20
recent coordinate-bearing selections and 50 saved places, IDs up to 128 characters,
labels up to 160, finite WGS84 `[longitude, latitude]` coordinates, locale/units and
captured routing/voice preferences. The destinations payload has a 64 KiB ceiling.
Query-only recent searches are not given invented coordinates.

Saved places are account-keyed; recent selections are scoped to the current
account. The shell stores **one current instance/account projection** in SQLite,
not a multi-account history. New updates replace the row, explicit empty lists
clear lists, sign-out removes saved places and switches recent scope, and reading
for another compiled instance deletes the old row. An account change clears
native preview/results and cancels outstanding planning. This cache contains
place labels, coordinates and an account identifier: it is personal data, even
though cookies and credentials never cross this bridge. Clearing depends on
receiving an update; the cache is not an independent authentication session.

The host list obeys its content limit. Search goes to the compiled instance's
public geocoding API with omitted credentials, a 350 ms debounce, cancellation,
timeout and bounded results. Coordinate `geo:`/`google.navigation:` requests and
address queries received by the car session enter this same planning/search flow;
end-to-end external-intent delivery needs device verification.

`CarRoutePlanner` obtains a fresh shell location fix with background permission
and requests driving directions through `fetchDirections`, outside the coordinator
queue. It rejects a missing fix, one older than 15 seconds or accuracy worse than
100 meters, builds validated ground navigation packages and keeps up to eight
candidates. Preview rows show each candidate's duration and distance with a
letter badge (A, B, C …); the map draws the same letter where that route departs
furthest from the others, and the selected route above the alternatives. A row
tap re-highlights its route (`select` command); Start sits in the template's
action strip, because the host draws no action below a list there. The initial
selection is candidate zero. Search requests pass the car's last fix rounded to
about 1 km as `lat`/`lng`, so nearby places rank first, as on the phone. Start enters the shared
executor with command-generation checks. Replacing an active trip requires
confirmation bound to its session ID.

**Car-only cold-start boundary:** a connected host and background location grant
alone do not establish Android location foreground-service start eligibility.
The current gate requires a foreground process (a focused phone Activity, or the
car host showing OpenMapX, which Android reports as foreground importance) or an
already-running location service, plus host authorization and the background
grant. expo-location tracks foreground state from Activity events only, so the
module marks it foreground while the car shows OpenMapX; Android then permits the
location service start. Otherwise the car asks the user to finish setup on the
phone. Each planning failure has its own car message: phone setup, location not
yet available, no route, no connection, or unavailable. The car runtime does not fabricate phone
visibility or present first-time permission prompts. General Activity-absent
cold-start trip creation remains unqualified, even though runtime bootstrap and
existing-trip attachment have code paths without an Activity.

### Notifications and audio

The turn-by-turn notification Android Auto requires (NF-3) is the trip's existing
phone navigation card from the navigation-surfaces module, not a second
notification. While a car is connected, the car module decorates that card through
`NavigationSurfaceHooks` with a `CarAppExtender`: turn instruction, distance and
the phone's turn glyph for the car rail. A new turn re-posts the card and alerts
only while another app is on the car screen; while OpenMapX is shown, its routing
card already presents it. Distances otherwise follow the card's own update
cadence. Disconnecting re-posts the card without the extension. A card the user
dismissed on the phone stays dismissed, so the car rail then shows no turn either;
notification permission denial is respected the same way.

Speech uses the existing navigation audio ports. No second car TTS engine or
forced Bluetooth SCO routing is introduced. Real vehicle focus, ducking, calls
and speaker routing cannot be accepted from DHU alone.

## Car surface protocol

Every JSON message has `{ v: 1, type, ... }`. This is separate from the nested
phone bridge's protocol v3. The page sends through
`OpenMapXCar.postMessage(JSON.stringify(message))`; native replies through
`JavaScriptReplyProxy`, delivered to `OpenMapXCar.onmessage`.

| Direction     | Type            | Fields and meaning                                                                                                             |
| ------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Native → page | `car-hello`     | `locale: "en" \| "de"`, `units: "metric" \| "imperial"`, `dark: boolean`; after ready                                          |
| Native → page | `car-viewport`  | `width`, `height`, `stable` and `visible` edge insets `{top,right,bottom,left}`, `dark`; CSS pixels                            |
| Native → page | `car-snapshot`  | `message`: validated phone `snapshot.update` (full/progress) or `session.stopped` envelope                                     |
| Native → page | `car-preview`   | `routes: [{coordinates: [lng,lat][]}]`, `selected` index; `{routes: []}` clears, without `selected`                            |
| Native → page | `car-camera`    | `action: "pan"` with `dx,dy`; `"zoom"` with `factor` and optional `x,y`; `"fling"` with `vx,vy`; `"recenter"`; or `"overview"` |
| Native → page | `car-position`  | `lng`, `lat`, `accuracy`, optional `bearing`, `speedMps`; idle map position only                                               |
| Page → native | `car-ready`     | No extra fields; listener installed                                                                                            |
| Page → native | `car-map-state` | `following: boolean`; controls recenter visibility                                                                             |
| Page → native | `car-error`     | Bounded lowercase/hyphen/digit `code`; gap requests full state, style/WebGL loss requests recovery                             |

The shared parser uses strict shapes, finite bounds, the 8 MiB mobile message
ceiling and aggregate snapshot limits. Preview permits up to nine routes and
100,000 coordinates across them (the planner currently produces at most eight).
Viewport dimensions/insets are bounded at 32,768 and must leave positive safe
areas. Native separately limits page-to-host messages to 4,096 characters and
checks origin, main frame and version. Do not assume native parses every field
with the shared TypeScript Zod validator.

## Platform requirements and review

Source and linked Google requirements checked **4 November 2026**:

| Requirement     | Current choice                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Car library     | `androidx.car.app:app`, `app-projected` and test `app-testing` pinned to **1.7.0** in the module Gradle file; see [release notes](https://developer.android.com/jetpack/androidx/releases/car-app)                      |
| Host API        | Manifest `androidx.car.app.minCarApiLevel` **7**, for `MapWithContentTemplate`; deliberately excludes older hosts                                                                                                       |
| Android SDK     | Shell `minSdkVersion` 24, `compileSdkVersion` 36, `targetSdkVersion` 36; host Car API is a different version axis                                                                                                       |
| Play target     | New phone/Android Auto apps and updates require API **36** from **31 August 2026**; the AAOS exception does not apply; see [Play policy](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en) |
| Declaration     | Navigation-category `CarAppService`, automotive template descriptor, `NAVIGATION_TEMPLATES` and `ACCESS_SURFACE`; internal runtime service is not exported                                                              |
| Host validation | Debuggable builds allow all hosts; production uses AndroidX's signed host allowlist                                                                                                                                     |

Google's [quality tiers](https://developer.android.com/docs/quality-guidelines/car-app-quality#car-quality-tiers)
distinguish Tier 3 (Car ready, primarily parked apps), Tier 2 (Car optimized,
required for driving categories such as navigation) and Tier 1 (Car differentiated,
additional adaptation across car hardware). OpenMapX has not earned a tier by
implementing templates. Validate all applicable navigation requirements, including
notifications, cluster metadata, host stop, navigation intents and test driving,
and obtain Play car review. Recheck policy at submission time.

## Desktop Head Unit on macOS

This is a reproducible test procedure, not a completed acceptance receipt.
Google's [DHU guide](https://developer.android.com/training/cars/testing/dhu),
checked **4 November 2026**, documents the head-unit server and adb tunnel.
Use a phone with current Android Auto or a **Google Play-enabled phone emulator**
whose Android Auto installation/provisioning actually works. A plain AOSP or
`google_apis` image is not equivalent. If Play reports incompatibility, record
that blocker; do not substitute AAOS testing for Android Auto.

### Install and provision

The JDK path below is the research machine's exact path; replace it if your local
JDK 17 installation differs. Keep the SDK path consistent with Android Studio.

```bash
export JAVA_HOME=/opt/homebrew/Cellar/openjdk@17/17.0.21.0.3/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
sdkmanager 'extras;google;auto'
file "$ANDROID_HOME/extras/google/auto/desktop-head-unit"
```

On Apple silicon, check the executable architecture and Rosetta availability if
needed. Keep the bundled libusb beside the executable. If necessary, from that
directory run:

```bash
chmod +x ./desktop-head-unit
```

Boot the Play-enabled phone emulator in Android Studio Device Manager, or connect
a phone with USB debugging enabled. In T3, use the device tools and their returned
command for app/settings interaction; adb remains appropriate for builds,
installation, port forwards and logs. Sign in to Play and update Android Auto.
Open Android Auto settings, tap its version repeatedly to enable developer mode,
allow new cars and enable the applicable development/unknown-source setting for
sideloaded templated apps. Choose **Start head unit server** in the developer menu.

### Build, install and connect

Use the actual implementation checkout and configured origins. Clean prebuild
replaces generated native projects: keep no hand edits there, and do not run it
while Gradle is using them.

```bash
# From apps/mobile, with JAVA_HOME and ANDROID_HOME above:
npx expo prebuild --clean --no-install
# From apps/mobile/android:
./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a
adb -s emulator-5554 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 forward tcp:5277 tcp:5277
# From $ANDROID_HOME/extras/google/auto:
./desktop-head-unit
```

Replace `emulator-5554` with the serial from `adb devices -l`, and choose the build
architecture for the device. For a single attached device, the tunnel is simply
`adb forward tcp:5277 tcp:5277`. A debug/dev-client build can require Metro:

```bash
pnpm -C apps/mobile start
adb reverse tcp:8081 tcp:8081
```

Those commands assume the repository root and a single adb device; select its
serial when several are attached. Also test a bundled build without Metro before
claiming background readiness. The compiled default development origin is not an
automatically running local web server; deploy a matching web build containing
`/car` and the destinations bridge.

### Host configurations and test drive

Save the following as `openmapx-800.ini` outside tracked source:

```ini
[general]
touch = true
controller = false
resolution = 800x480
dpi = 160
framerate = 30
instrumentcluster = true
```

Create `openmapx-wide.ini` from it with `resolution = 1280x720`. Run each from the
DHU directory, using the actual absolute config paths:

```bash
./desktop-head-unit -c /path/to/openmapx-800.ini
./desktop-head-unit -c /path/to/openmapx-wide.ini
```

Exercise dashboard split/full transitions and touch/rotary configurations using
the SDK's `config/` samples. Record actual surface/stable/visible areas rather
than assuming the configured video size equals the map area. Instrument-cluster
emulation checks next-turn metadata. Rich secondary cluster-display emulation
requires DHU 2.1 beta according to the checked guide; OpenMapX does not declare a
separate cluster-map feature.

On a debuggable native build with development JS, start a ground trip after phone
setup, then select **Test drive** in the car navigation actions. It substitutes
the shared location driver and sends one fix per second through the same
coordinator batch path: positions 10 m apart along the route (10 m/s, accuracy
5 m) from core's `simulatePositions`, the generator behind the web's navigation
simulator. Permission checks still read real OS grants. Speed is constant; it is
not a traffic or road-speed simulation. Stop or detach restores the production driver;
it is not a production template action.

**Play review test drive (NF-7).** Release builds implement
`NavigationManagerCallback.onAutoDriveEnabled`, which Play reviewers trigger with:

```bash
adb shell dumpsys activity service \
  org.openmapx.app/org.openmapx.androidauto.OpenMapXCarService AUTO_DRIVE
```

For the rest of that car session, route planning starts from a fixed point south
of Alexanderplatz in Berlin instead of the phone's position, search ranks results
around it, and Destinations offers "Test drive: Brandenburg Gate, Berlin". A trip
started in this mode replays its route through the same simulated driver, installed
before the start so no real location service runs. The fixed start exists because
the official instance's routing and search cover Germany only; a reviewer elsewhere
would otherwise get no route. The phone still needs location permission ("Allow all
the time"), because the shared start policy reads real grants. Nothing else can
switch the mode on, and it ends with the car session.

During acceptance, cover phone-start then connect, car search/recent/saved-place
preview and start, replacement confirmation, pan/zoom/recenter, reroute loading,
day/night, split/full, reload, lock, Activity removal without force-stop,
disconnect/reconnect, stop from either side and competing-navigation host stop.
Check the cold-start rejection separately from resuming an existing trip. Record
build/web/Android Auto/DHU versions, host API, session/revision continuity,
notification behavior, frame/memory observations and inspected screenshots.

{/* <!-- screenshots: added after DHU verification --> */}

## Checks and remaining qualification

Focused source suites exist for protocol/reconciliation, destination scoping,
planning/cancellation, coordinator start policy and native templates/mapping,
notifications and viewport math. Developer entry points are:

```bash
pnpm -C apps/mobile test
pnpm -C apps/mobile test:native
pnpm exec vitest run packages/core/src/navigation/carSurfaceProtocol.test.ts apps/web/src/app/car/carSurface.test.ts
# From apps/mobile/android, after prebuild, with a test device connected:
./gradlew :openmapx-android-auto:connectedDebugAndroidTest
```

`PresentationWebGlTest` is a bounded device harness using an ImageReader-backed
VirtualDisplay and the installed MapLibre distribution. It checks rendering and
display recreation without an Activity. It does not exercise a host
`SurfaceContainer`, the deployed `/car` route, locked-phone behavior or RN
bootstrap. JVM and browser fixtures likewise do not establish DHU acceptance.

This documentation work does not qualify real head units, wired/wireless hosts,
vehicle audio/focus, physical GPS, OEM process survival, notification/FGS delivery,
Play review or store publication. There is no guaranteed offline cold start of
the remotely served map page. Car-only cold-start eligibility remains bounded as
above. Retain separate DHU, physical-device/head-unit and Play review evidence;
store copy stays restricted until the latter qualification gates pass. See
[Mobile feasibility](./mobile-feasibility.md) and [Mobile release](./mobile-release.md).
