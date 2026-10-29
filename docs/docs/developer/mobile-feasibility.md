---
title: Mobile feasibility and the provisional location driver
description: Run focused mobile checks, interpret historical virtual-device evidence and qualify the location driver.
sidebar_position: 8
---

# Mobile feasibility and the provisional location driver

OpenMapX uses Expo Continuous Native Generation. Committed inputs include
`app.config.ts`, config plugins, TypeScript and the local Swift/Kotlin audio
module. The `ios/` and `android/` projects are ignored generated output.

The location driver remains provisional. The committed reports under
`apps/mobile/qa/results/` record virtual-device launch checks from 10 August 2026,
not qualification of the current source or background guidance.

## What this evidence can and cannot show

Both historical reports record zero location callbacks and zero accepted fixes.
Start, Profile, Arm audio, End and recovery scenarios were not exercised. All
hardware observations remain `not-verified`. Their `virtual-pass` conclusions
apply to the recorded build/install/launch observations only.

The current foreground app does not dispatch native navigation commands. Read
[Mobile architecture](./mobile-architecture.md) before trying an end-to-end
navigation scenario. Processor, repository and bridge tests can pass without a
working installed navigation flow.

Virtual-device runs can exercise launch, layout, permissions and injected
lifecycle conditions. Physical devices are required for real suspension,
background delivery, OEM power management, audio routing, battery and thermal
behavior. `qa/assumptions/location-driver.json` remains
`expo-location-provisional` and blocks public rollout until the volunteer matrix
is complete.

## The automated gate

Install the locked dependencies first. For native policy tests, use macOS with
Xcode, an Android SDK and JDK 17 or 21. Run from the repository root:

```bash
pnpm mobile:verify
pnpm mobile:prebuild:check
pnpm mobile:bundle:check
```

### `pnpm mobile:verify`

Runs Jest, the native audio-policy suites, mobile TypeScript checks and the
project's Expo doctor wrapper, in order. Jest includes the fixed-origin policy,
bridge, coordinator, processors and SQLite-backed repository tests. SwiftPM and
Gradle test framework-free audio policy. They do not exercise the real
`AVAudioSession` or Android `TextToSpeech` behavior. Compiling a Release build
also does not establish that those APIs behave correctly on hardware.

The native test runner can generate the Android project if it is absent. Expo
doctor uses `scripts/doctorPolicy.ts`; inspect tolerated findings and failures
rather than treating every doctor message as equivalent.

### `pnpm mobile:prebuild:check`

This deletes and regenerates `apps/mobile/ios` and `apps/mobile/android` twice.
Keep no hand edits or secret recovery material there. The script compares
normalized identifiers, permissions, App-Bound Domains, background modes, URL
schemes, entitlements, associated domains, transport policy, foreground-service
type and SDK levels. It ignores nondeterministic project identifiers/order and
fails if generated files are tracked by Git.

### `pnpm mobile:bundle:check`

Metro bundles `src/background/defineNavigationTask.ts` for iOS with `--dev false`.
The source-map check rejects browser/framework dependencies on the headless path,
multiple resolved versions of React, React Native, `expo-modules-core` or Zod,
and feasibility-probe modules. It prints module count and bundle size. This is a
graph-policy check for that entry, not an inspection of both final store binaries.

## The virtual-device procedure

First choose what you are checking:

- For Release-configuration build/install/launch, use the commands below with
  feasibility mode off. These use a development identity because
  `OPENMAPX_MOBILE_RELEASE=0`; Release configuration is not store qualification.
- For interactive probe delivery, use a development bundle with `__DEV__` true.
  `defineNavigationTask.ts` removes the probe branch from Release bundles, even
  when the overlay flag is present. A Release overlay showing zero callbacks
  cannot qualify the probe.

```bash
OPENMAPX_MOBILE_RELEASE=0 OPENMAPX_MOBILE_FEASIBILITY_MODE=0 \
  pnpm mobile:build:ios --device "iPhone 17"
OPENMAPX_MOBILE_RELEASE=0 OPENMAPX_MOBILE_FEASIBILITY_MODE=0 \
  pnpm mobile:build:android
```

For a development probe, set both flags in the terminal that serves the dev
bundle and the terminal that generates/runs the app:

```bash
export OPENMAPX_MOBILE_RELEASE=0
export OPENMAPX_MOBILE_FEASIBILITY_MODE=1
pnpm -C apps/mobile start
# In a second terminal with the same flags, choose one platform:
pnpm -C apps/mobile ios --configuration Debug
pnpm -C apps/mobile android --variant debug
```

Use a simulator/emulator available on the host. A local web origin needs matching
build-time origin configuration; a store release refuses non-public origins and
refuses the official identity against another origin.

With the developer probe running:

1. Press **Start**, read the disclosure, then press **Start** again while the app
   is foregrounded.
2. Grant foreground, then background location. Inspect `permission:` and
   `stream running:`.
3. Background the app and simulate movement with the simulator location controls
   or `adb emu geo fix`. Record callback and accepted/rejected-fix counts.
4. Press **Profile**. Verify one stream remains running and callbacks continue.
5. Press **Arm audio**. The next accepted callback should request one probe
   utterance; record the actual outcome.
6. Press **End**. Verify `stream running: false`. Treat `END FAILED: still running`
   as a failure.

Record only observed outcomes. Validate feasibility-format reports with:

```bash
pnpm mobile:qa:validate apps/mobile/qa/results/ios-simulator.json
```

## Why the reports cannot overstate themselves

`qa/feasibility.schema.json` is a closed schema. It permits `physical-pass` only
with `evidenceSource: "physical"`, and requires hardware-only observations to stay
`not-verified` for virtual runs. `mobile:qa:validate` applies this schema and a
forbidden-content scan. Free-text fields still need manual privacy review; schema
validity does not prove a run occurred or remove all identifying information.

Release-candidate reports use the separate
`qa/release/release-candidate-report.schema.json`. The feasibility validator does
not validate that format. See the beta report README before collecting it.

## The unverified risks

The driver decision schema requires all eight risks exactly once:

| Risk                                   | Required physical evidence                         |
| -------------------------------------- | -------------------------------------------------- |
| `ios-suspension-delivery`              | Real iOS suspension and resumed callback delivery  |
| `android-oem-background-killing`       | Vendor hardware with default power settings        |
| `real-permission-settings-transitions` | Real Settings round trips and permission changes   |
| `locked-screen-callback-gaps`          | Locked screen with a real location provider        |
| `silent-mode-speech`                   | Platform mute/silent settings and actual audio     |
| `bluetooth-audio-focus`                | Real Bluetooth routing and competing audio         |
| `battery-drain`                        | Measured battery use over a recorded trip duration |
| `thermal-behavior`                     | Hardware thermal observations                      |

## The deferred volunteer-beta procedure

After foreground composition and local candidate qualification, test the exact
processed TestFlight/Play build on current-iOS iPhone, API 36 Pixel-class Android
and recent Samsung hardware with default battery management. Record installed
version/build, source, web build and available artifact identity evidence.

Run the ground, transit and secure-shell scenarios. Keep reports at
`apps/mobile/qa/results/beta/<version>-<family>.json`. The decision may move to
`beta-qualified` only after all three family reports exist and every risk is
resolved. The schema records those paths; maintainers must also inspect the
reports and evidence behind them.

If the same driver-specific background-survival, delivery-gap, duplicate-stream
or teardown failure reproduces twice on the same beta build, evaluate the narrow
native `LocationDriver` replacement. Record both reproductions and the maintainer
decision. Audio, WebView, configuration and engine failures belong to their own
subsystems. The schema does not implement an automatic driver switch.

## Local smoke flows

Maestro runs locally against an installed simulator/emulator app:

```bash
pnpm mobile:smoke
MAESTRO_APP_ID=org.openmapx.app.dev pnpm mobile:smoke
```

If Maestro is missing, the wrapper **exits 0 with a skip message**. Report that as
skipped. A flow that runs and fails makes the command fail.

| Flow                   | Required observation                                    |
| ---------------------- | ------------------------------------------------------- |
| `launch.yaml`          | No permission request at launch                         |
| `webview-reload.yaml`  | Reload rotates the channel and renegotiates             |
| `foreground-only.yaml` | Foreground-only guidance pauses when visibility is lost |

The bridge flows require the local protocol fixture and a development origin.
They do not establish the same flow through the uncomposed production app.

## Secure shell verification

Run the automated gate, local smoke flows and `pnpm check-translations` when
changing shell behavior. Record each executed, failed or skipped check separately.
The bundle probe-exclusion check covers the background entry; inspect the final
artifact for any remaining qualification UI or code before distribution.

## Storage cleanup

Repository tests inspect row counts and column names without exporting values.
After terminal cleanup, keep only the bounded acknowledgement and stop-command
deduplication receipt needed for idempotent replies. Active session, last fix,
route, refresh token, alert rows and queued events must be gone.

Use `qa/beta/secure-shell-scenarios.md` for physical storage/lifecycle checks.
A test database dump does not establish the state of an installed binary.

## Ground navigation qualification

`src/navigation/ground/ground.e2e.test.ts` exercises the coordinator, SQLite
repository, processor, effect runner and snapshot publication with external
clock/location/speech/network ports replaced. It covers monotonic progress and
revisions, restart/redelivery cue deduplication, captured-route processing without
network, failed reroute retention, stop finality and terminal cleanup.

### The background limitation, stated plainly

OS location callbacks drive background processing. JavaScript timers cannot
supply guidance while the process is suspended. Coasting is foreground-only and
refuses stationary, off-route and rerouting states. Delayed batches can trigger
bounded catch-up when a real fix arrives; they cannot create guidance during a
total blackout. Ground cues older than ten seconds are recorded without speaking.

### Physical cases

Run `qa/beta/ground-scenarios.md` for locked-screen audio, delivery gaps, power
management, battery, thermal behavior and Bluetooth. Use the synthetic fixture
in `qa/fixtures/ground-field-route.json`; do not commit a person's journey.

## Transit navigation qualification

`src/navigation/transit/transit.e2e.test.ts` exercises the coordinator, repository
and processor with external ports replaced. It covers increasing revisions,
non-regressing legs, schedule fallback, restart cue deduplication, token exclusion
from bridge output, whole-itinerary replacement and cleanup.

### The token discipline, stated plainly

Native transit refresh has one rotating-token consumer. A rejected or ambiguous
request breaks the chain and requires replan. Reuse is allowed only when the
request is known not to have reached the server. Replan/replacement changes the
generation so late work cannot adopt stale results. Never publish the token in a
snapshot, diagnostic or error.

### What is not claimed

Schedule-driven progress is an estimate, with `gps`, `schedule` or `stale`
confidence. It does not establish the rider's underground station. Timers do not
wake a suspended process to advance transit progress.

### Physical cases

Run `qa/beta/transit-scenarios.md`, including alighting alerts and Focus/Do Not
Disturb behavior. Describe route shape and outcome without trip IDs, stop names,
precise service times or coordinates. The synthetic itinerary fixture contains no
recorded personal trip.
