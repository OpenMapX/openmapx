# Android Auto native host

Android-only local Expo module, autolinked through `expo-module.config.json`.
See the [Android Auto developer guide](../../../../docs/docs/developer/android-auto.md)
for architecture, the surface protocol, platform requirements, privacy, DHU
commands and qualification limits.

## Ownership

- The library manifest owns `OpenMapXCarService`, the internal runtime service,
  the automotive descriptor, surface/navigation permissions and Car API 7 floor.
  Gradle pins AndroidX Car App/app-projected/app-testing to 1.7.0. The native config
  plugin supplies the compiled web origin and Activity navigation-intent filters.
  Debuggable builds allow all hosts; production uses signed host validation.
- `CarSurfaceHost` loads the compiled origin's `/car` map-only page in a WebView
  inside a Presentation/VirtualDisplay. Directions, lanes, ETA and destination
  controls belong to host templates. `carSurfaceProtocol.ts` owns the v1 surface
  contract; dimensions/insets/gestures use CSS pixels converted by `dpi / 160`.
- `OpenMapXCarRuntime` is registered at shell entry. `CarRuntimeService` starts it
  through the application's existing ReactHost. `src/car/carRuntime.ts` reuses the
  phone coordinator or composes car ports over the shared executor/repository.
  There is no second navigation engine. Commands remain in the native mailbox
  until JS acknowledgment; snapshots fan out from committed state.
- The optional phone bridge `carDestinations` capability supplies bounded recent
  selections, saved places and preferences. SQLite holds one current instance/account
  projection. No cookies or credentials cross the bridge. Search and route planning
  use the compiled public API with omitted credentials.

## Start and lifecycle boundaries

A car trip start needs host authorization, background location permission and
Android service-start eligibility: currently a focused phone Activity or an
already-running location service. Otherwise the car requests phone setup.
General car-only cold-start trip creation remains unqualified. Do not fake phone
visibility to bypass this gate.

Host stop enters the shared coordinator and cancels car planning/replay. Ordinary
detach releases car resources without issuing a trip stop. Guidance notifications
use `CarAppExtender` and reuse/restore the Expo location notification when present;
actual notification/service coexistence and vehicle audio need device acceptance.
The debug Test drive action replays route coordinates through the shared location
port and keeps permission checks tied to real OS grants.

## Checks and handoff

From the repository root:

```bash
pnpm -C apps/mobile test
pnpm -C apps/mobile test:native
```

After prebuild, from `apps/mobile/android`, with a test device connected:

```bash
./gradlew :openmapx-android-auto:connectedDebugAndroidTest
```

Do not run clean prebuild while Gradle uses the generated project.
`PresentationWebGlTest` tests an ImageReader-backed VirtualDisplay with the
installed MapLibre distribution, not the deployed `/car`, real host surface,
lock state or RN bootstrap. The guide separates these from DHU, real head-unit
and Play-review evidence. Store claims remain forbidden until real head-unit
qualification and Play review. No AAOS or CarPlay implementation is included.
