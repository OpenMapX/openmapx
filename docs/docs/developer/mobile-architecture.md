---
title: Mobile architecture
description: Installed-shell capabilities, navigation authority, bridge messages and trust boundaries.
sidebar_position: 9
---

# Mobile architecture

The installed app renders the web UI in a React Native WebView at a fixed origin.
The shell restricts navigation and exposes a versioned bridge. Native navigation
processors, persistence, audio and recovery components exist, but the foreground
app does not yet connect them to bridge commands.

`apps/mobile/src/App.tsx` calls `createShellBridge` without a dispatcher or
capability providers. The handshake therefore reports ground navigation, transit
navigation, background location, local notifications and speech as unavailable.
Commands other than event acknowledgements receive `unsupported-capability`.
Do not describe this composition as a working background-navigation release.

## Why there is a split at all

Native navigation components are intended to own work that must continue when
the WebView is suspended: location delivery, progress, cues, alerts and durable
session state. The web UI owns rendering, search, route planning and place details.

A browser or PWA uses browser navigation facilities. Inside the installed shell,
the web runtime selects native authority before the handshake and disables its
browser engine. Missing native composition does not enable a browser fallback.
This avoids competing location streams, speech and session records, but currently
leaves installed navigation unavailable.

## The authority matrix

| Concern                                                               | Browser or PWA                            | Installed shell                                                         |
| --------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| Rendering, search and route planning                                  | Web UI                                    | Web UI                                                                  |
| Browser geolocation, speech, notifications and navigation persistence | Browser facilities                        | Disabled by the shell descriptor                                        |
| Ground and transit navigation                                         | Browser engine                            | Native authority selected; capability currently false                   |
| Background location, local alerts and speech                          | Subject to browser limits                 | Capability currently false                                              |
| Durable native session                                                | Not used                                  | SQLite components and recovery exist; session commands are not composed |
| One-shot location, settings, authentication and deep-link commands    | Browser flows                             | Protocol vocabulary exists; dispatch is not composed                    |
| Community frontend bundles                                            | Disabled                                  | Disabled                                                                |
| Microphone input                                                      | Subject to browser support and permission | Disabled                                                                |

The immutable descriptor is injected before page scripts run. Shell restrictions
use that descriptor, so they apply during negotiation, incompatibility and errors.
`MobileRuntimeProvider.tsx` is the web authority boundary;
`createShellBridge.ts` supplies the current capability report.

## The bridge protocol

Both sides currently support protocol **v3 only**. The constants in
`packages/core/src/navigation/mobileProtocol.ts` and the release descriptor in
`apps/mobile/release/version.json` agree on `min: 3, max: 3`. A non-overlapping
range leaves navigation disabled and requires an update. Protocol negotiation
alone does not establish that a command is implemented.

### Rollout order

Before changing the protocol, identify the actually deployed shell and web
versions. Define and test their overlap, deploy a compatible web build, then ship
the native build and enable the new capability. The current first-candidate
configuration has no older version in its compatibility matrix.

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

## Fixed origin

`config/mobileConfig.ts` validates the origin at build time. Release origins must
use HTTPS and pass its public-host checks. The official application identifier
`org.openmapx.app` is restricted to `https://openmapx.com` for both web and API.
There is no runtime server selector.

`App.tsx` applies a navigation allowlist, App-Bound Domains on iOS, disabled
WebView geolocation and denied media capture. Deep-link parsing reduces accepted
links to a map query or an active-navigation intent; parser support does not
establish end-to-end OS link delivery in the current app.

Self-hosted distributions need their own application identifier, scheme, signing,
associations, origin and trademark-compliant name.

## Authentication

Email/password, verification, email OTP and TOTP use the web UI and its session
cookie. The system-browser handoff components support sign-in, provider linking
and passkey setup, but `App.tsx` does not currently dispatch `auth.open` to them.
Successful helper tests therefore do not establish installed OAuth or passkey
sign-in.

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

## What is not here

There is no EAS build configuration, hosted wrapper, remote push or native OTA
update channel in the release design. `ios/` and `android/` are ignored generated
projects. Change committed configuration, plugins or local modules, then
regenerate them. See [Mobile feasibility](./mobile-feasibility.md) for evidence
limits and [Mobile release](./mobile-release.md) for release blockers.
