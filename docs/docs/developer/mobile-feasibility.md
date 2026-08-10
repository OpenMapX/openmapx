---
title: Mobile feasibility and the provisional location driver
description: How to reproduce the OpenMapX mobile app's automated and virtual-device feasibility evidence, and what remains unverified until volunteer store-beta testers report.
sidebar_position: 8
---

# Mobile feasibility and the provisional location driver

The OpenMapX mobile app is an [Expo Continuous Native Generation](https://docs.expo.dev/more/glossary-of-terms/)
host: `app.config.ts`, config plugins, TypeScript, and two narrow Swift/Kotlin
files are the committed source, and `ios/`/`android/` are regenerated build
output. This page is the reproducible procedure behind that claim, and — just as
importantly — the record of what it does **not** establish.

## What this evidence can and cannot show

The app's core promise is that guidance keeps running while the screen is locked.
Nothing on this page proves that.

A simulator does not suspend an app the way a real iPhone does. An emulator does
not run a vendor battery manager. Neither has a real GPS chip, a silent switch, a
Bluetooth headset, or a thermal budget. So the automated and virtual gates below
prove a different, still-necessary set of things: that the architecture is
sound, that the background code path commits to SQLite without mounting React,
that exactly one location stream can exist, that teardown is prompt, and that the
native projects regenerate identically from committed configuration.

Real background reliability is deferred to volunteer TestFlight and Play testers,
and public rollout stays blocked until they report. `qa/assumptions/location-driver.json`
encodes that in a schema which cannot express "provisional but unblocked".

## The automated gate

Run from the repository root:

```bash
pnpm mobile:verify          # jest + Swift + Kotlin suites, types, expo-doctor
pnpm mobile:prebuild:check  # two clean CNG generations, compared on policy
pnpm mobile:bundle:check    # real Metro graph of the background entry
```

### `pnpm mobile:verify`

Runs, in order:

- the Jest suite (`apps/mobile/src`, `apps/mobile/modules`), including the
  fixed-origin WebView policy, the batch handler's ordering/deduplication rules,
  the SQLite repository against a real SQLite engine, and the audio contract;
- `pnpm -C apps/mobile test:native`, which runs the module's Swift policy suite
  through SwiftPM and its Kotlin policy suite through the generated Gradle
  project (regenerating that project first if it is absent);
- `tsc --noEmit`;
- `expo-doctor`.

The native suites cover the framework-free half of the audio module — cue
deduplication and eviction, audio-session and audio-focus transitions,
interruption handling, locale selection, rate clamping and input bounds. The half
that touches `AVAudioSession` and `TextToSpeech` is covered by the local Release
builds instead: committing an XCTest or instrumentation target *inside* a
generated project would contradict the rule that those projects are disposable.

### `pnpm mobile:prebuild:check`

Deletes only `apps/mobile/ios` and `apps/mobile/android`, regenerates both twice
with `expo prebuild --clean`, and compares a normalized view of the result:
identifiers, permissions, App-Bound Domains, background modes, URL schemes,
entitlements, associated domains, transport policy, foreground-service type, and
SDK levels. Xcode object UUIDs, file ordering and timestamps are ignored on
purpose — comparing those would fail constantly and teach everyone to skip the
check. It also fails if Git tracks any file inside a generated project.

### `pnpm mobile:bundle:check`

Bundles `src/background/defineNavigationTask.ts` with Metro — the bundler the app
actually ships with, not a stand-in — and inspects the dependency graph from the
emitted source map. It fails on React DOM, Zustand, Better Auth, TanStack Query,
`next-intl`, MapLibre, MUI, the web app, and `packages/core`'s stores, hooks and
browser storage, and on more than one copy of React, React Native,
`expo-modules-core` or Zod.

It prints the module count and bundle size, which is the baseline to watch when
adding a dependency to the background path.

## The virtual-device procedure

Both builds use the **Release** configuration, so the evidence comes from the
same optimisation and bundling path a store artifact would use. Neither requires
EAS, a cloud builder, or an Expo account.

```bash
# iOS: builds and installs on a booted simulator
OPENMAPX_MOBILE_RELEASE=0 OPENMAPX_MOBILE_FEASIBILITY_MODE=1 \
  pnpm mobile:build:ios --device "iPhone 17"

# Android: builds and installs on a running API 36 emulator
OPENMAPX_MOBILE_RELEASE=0 OPENMAPX_MOBILE_FEASIBILITY_MODE=1 \
  pnpm mobile:build:android
```

`OPENMAPX_MOBILE_FEASIBILITY_MODE=1` compiles in the developer probe overlay. It
is absent from any build made without that flag, which is what keeps it out of a
release artifact.

With the app running:

1. Press **Start**. Read the background-location disclosure, then press **Start**
   again. The probe refuses to start unless the app is foregrounded, because
   Android 14+ requires a location foreground service to begin while visible.
2. Grant foreground and then background location. Watch `permission:` and
   `stream running:` update.
3. Background the app. Simulate movement (Xcode's *Features → Location*, or
   `adb emu geo fix`). Watch `callbacks:` and `fixes accepted/rejected:` climb
   while no UI is in the foreground.
4. Press **Profile** to switch cadence. Confirm `stream running:` stays `true`
   and callbacks continue — one stream is replaced, not two started.
5. Press **Arm audio**. The next accepted callback speaks one probe utterance and
   records only a result code.
6. Press **End**. `stream running:` must become `false`. The overlay reports
   `END FAILED: still running` if teardown did not take effect.

Record the outcome as a report under `apps/mobile/qa/results/` and validate it:

```bash
pnpm mobile:qa:validate apps/mobile/qa/results/ios-simulator.json
```

## Why the reports cannot overstate themselves

`apps/mobile/qa/feasibility.schema.json` is closed (`additionalProperties: false`
throughout), so a report structurally cannot carry a coordinate, a route, a stop
sequence, an account or a device serial. Two conditional rules do the rest:

- a report may only conclude `physical-pass` when `evidenceSource` is `physical`;
- a `simulator` or `emulator` report must record **every** hardware-only
  observation as `not-verified`.

`pnpm mobile:qa:validate` enforces both, plus a content scan for forbidden
substrings.

## The unverified risks

`apps/mobile/qa/assumptions/location-driver.json` records the current decision.
It lists these eight risks, and the schema refuses to accept the record with any
of them missing:

| Risk | Why a virtual device cannot settle it |
|---|---|
| `ios-suspension-delivery` | The simulator does not suspend and resume an app the way iOS does. |
| `android-oem-background-killing` | Vendor battery managers exist only on vendor hardware. |
| `real-permission-settings-transitions` | Round trips through the real Settings app, including Allow Once escalation. |
| `locked-screen-callback-gaps` | Requires a locked physical screen and a real location provider. |
| `silent-mode-speech` | There is no hardware silent switch to test against. |
| `bluetooth-audio-focus` | Requires real Bluetooth routing and a competing audio app. |
| `battery-drain` | No battery. |
| `thermal-behavior` | No thermal budget. |

## The deferred volunteer-beta procedure

This runs in Plan 06, against the exact TestFlight and Play-signed artifacts —
not a local build, and not Expo Go.

Target matrix (at least one of each):

- a supported iPhone on current iOS;
- an Android 16 / API 36 Pixel-class device;
- a recent Samsung device with default battery management.

Each family runs representative ground and transit traces covering screen
lock and background transitions, network loss and recovery, WebView reload,
ordinary process recreation, low-accuracy gaps, permission revocation, local
alerts, audio environments, and End cleanup. Reports are sanitized, validated
against the same schema, and stored at
`apps/mobile/qa/results/beta/<version>-<family>.json`.

Only once all three families report, and every risk above is resolved, may
`location-driver.json` move to `beta-qualified`. A missing family is recorded as
an explicit public-rollout blocker; it is never inferred from simulator results.

If the same driver-specific background-survival, delivery-gap, duplicate-stream
or teardown failure reproduces **twice** on the same beta build, the narrow
native `LocationDriver` fallback is activated — and only the driver is replaced.
An audio, WebView, configuration or navigation-engine failure is fixed in its own
subsystem and does not justify a replacement location module.

## Local smoke flows

Maestro drives a local simulator or emulator. There is no hosted device farm,
no account, and nothing uploaded.

```bash
pnpm mobile:smoke                                  # every flow
MAESTRO_APP_ID=org.openmapx.app.dev pnpm mobile:smoke
```

The command reports and exits 0 when Maestro is not installed, because these
flows qualify a device that may not be attached — a missing local tool is not a
failure of the code. Any flow that actually runs and fails does fail the command.

| Flow | What it protects |
| --- | --- |
| `launch.yaml` | Nothing is requested at launch. A permission dialog on a cold start means some initialisation reached the driver before the user asked for anything. |
| `webview-reload.yaml` | A reload resets the bridge channel and nothing else, and the reloaded document renegotiates rather than reusing the old nonce. |
| `foreground-only.yaml` | Choosing the limited mode never requests background permission, and guidance pauses the moment the app stops being visible. |

The two bridge flows need a development build pointed at the local protocol
fixture. That is only possible in a development build: the release configuration
refuses a non-public origin, and refuses the official application id against any
origin but the official one.

## Secure shell verification

```bash
pnpm mobile:verify          # unit, native, types, doctor
pnpm mobile:prebuild:check  # two clean generations agree; projects untracked
pnpm mobile:bundle:check    # background graph is headless-safe
pnpm mobile:smoke           # local Maestro flows
pnpm check-translations
```

`mobile:bundle:check` also asserts that the qualification probe is **absent**
from a release bundle rather than merely unreachable in it. The probe sits
behind a `__DEV__` branch, which folds away under release minification; if that
branch is ever weakened, the check names the modules that reached the bundle.

## Storage cleanup

After a stop, an arrival or an expiry, the repository exposes a developer-only
dump reporting row counts and column names — never values.

What must remain: one `terminal_ack` row, and one `processed_commands` row for
the stop itself so a retried stop returns the same answer instead of running
again. Both hold the same non-sensitive envelope: session id, kind, final
status, revision, completion time.

What must be gone: the active session, the last accepted fix, the route, any
refresh token, every scheduled alert, and every queued event.

`apps/mobile/qa/beta/secure-shell-scenarios.md` lists the cases a simulator
cannot answer honestly. None of them may be marked verified from a simulator
run, a code review or an emulator screenshot.

## Ground navigation qualification

`apps/mobile/src/navigation/ground/ground.e2e.test.ts` drives a whole journey
through the production boundaries — the real coordinator, the real repository
over a real SQLite engine, the real processor, effect runner and snapshot
publisher. Only the outside world is faked: clock, location stream, speech and
network.

What it settles, so no volunteer has to:

| Property | How |
| --- | --- |
| One committed revision per batch | Revisions collected across a 20-fix drive and asserted strictly increasing |
| Progress never regresses | `alongMeters` collected across 30 fixes |
| No duplicate cue across a restart | The coordinator, processor and prepared-route cache are rebuilt between *every* fix; only the database survives |
| No cue replay on a redelivered batch | The same 20 fixes delivered twice |
| Captured route works offline | A full drive with a client that returns no route |
| A failed reroute keeps the old route | Deliberate deviation with an empty answer |
| Stop is final | A batch delivered after the stop does not resurrect the session |
| Cleanup is complete | Row counts after stop: one acknowledgement, nothing location-bearing |

### The background limitation, stated plainly

Operating-system location callbacks are the **only** reliable background wake
source. A JavaScript timer does not run while iOS or Android has suspended the
app, and this shell does not pretend otherwise:

- coasting is foreground-only, and refuses to extrapolate while off route,
  stationary or rerouting;
- a delivery gap is filled with bounded synthetic points *after the fact*, when
  the next real fix arrives — never invented while nothing was running;
- after a long blackout the coast decelerates to a stop where the estimate ran
  out. It does not jump to wherever the user turned out to be;
- a cue older than ten seconds is recorded as reached and not spoken, because
  announcing a turn already behind the user would send them the wrong way.

A total callback blackout therefore produces no real-time guidance. OpenMapX
catches up safely when delivery resumes, and no review or store text may claim
more than that.

### Physical cases

`apps/mobile/qa/beta/ground-scenarios.md` lists what a simulator cannot answer:
locked-screen audio, background delivery, battery and thermal behaviour,
Bluetooth routing, OEM battery management. None may be marked verified without a
named volunteer, a physical device and a recorded build.

`apps/mobile/qa/fixtures/ground-field-route.json` describes the synthetic replay
route rather than containing a recorded one — a real captured trace is somebody's
journey, and that file is public.

## Transit navigation qualification

`apps/mobile/src/navigation/transit/transit.e2e.test.ts` drives a whole journey
through the production boundaries, with only the outside world faked.

What it settles:

| Property | How |
| --- | --- |
| One revision per tick, strictly increasing | Collected across a 40-minute ride |
| A leg that never moves backwards | Collected minute by minute |
| Schedule fallback with no position at all | Every tick delivered with an empty batch after one seeding fix |
| Schedule progress labelled honestly | Confidence asserted as not `gps` |
| No duplicate cue across a restart | Coordinator, processor and prepared index rebuilt between every tick |
| The rotating token never published | Every bridge message searched for the fixture token |
| A replacement adopted whole | New itinerary, new token, reset leg |
| Complete cleanup after a stop | Row counts, and the terminal row searched for token, stop names and coordinates |

### The token discipline, stated plainly

The refresh token is one-time: each call returns a replacement and invalidates
what was sent. Native is its only consumer.

- **A rejection breaks the chain.** The token is provably gone.
- **An ambiguous timeout also breaks it.** The server may or may not have
  consumed it, and the only safe reading of "we do not know" is that it was.
  Retrying blindly is a coin flip that silently ends live data when it loses.
  Recovery is a full replan.
- **Only an unreachable request may reuse the token**, because it never arrived.
- **A generation invalidates in-flight work**, so a reply already on the wire
  after a replan or replacement lands on nothing.

### What is not claimed

Station-level underground precision. Confidence is `gps`, `schedule` or `stale`,
and a schedule-driven leg advance is never presented as a physical observation.

### Physical cases

`apps/mobile/qa/beta/transit-scenarios.md` lists what a simulator cannot answer,
with the alighting alert first — missing a stop is the transit failure a rider
cannot quickly recover from. Reports are sanitised: shape and outcome, never trip
ids, stop names, precise times or coordinates.

`apps/mobile/qa/fixtures/transit-field-itinerary.json` describes the synthetic
replay itinerary rather than containing a recorded one, for the same reason.
