---
title: Mobile architecture — authority, protocol, and trust boundaries
description: How the OpenMapX installed app and the web UI divide responsibility, what crosses the bridge, how authentication works, and what is deliberately not guaranteed.
sidebar_position: 9
---

# Mobile architecture

The installed OpenMapX app is a native shell around the real web UI. That
sentence hides the only question that matters: when the app is running, who is
actually doing the navigating?

The answer is native, always — and everything below follows from making that
answer unambiguous rather than approximate.

## Why there is a split at all

A browser cannot keep guiding somebody with the screen off. Background tabs are
throttled, geolocation watches stop, speech is suspended, and the page may be
discarded entirely. None of that is a bug to work around; it is what a browser is
for.

So the parts of navigation that must survive a locked screen — the location
stream, progress along the route, voice cues, the get-off alert, the durable
session — live natively. The parts that are a map application — search, route
planning, place details, everything the user actually looks at — stay in the web
UI, which is the same code the website runs.

The failure this design exists to prevent is both halves doing the same job.
Two location watches produce two answers to "where am I". Two voice owners talk
over each other. Two durable session records disagree the first time one crashes.

## The authority matrix

| Concern | Ordinary browser / PWA | Installed shell |
| --- | --- | --- |
| Location stream | Browser geolocation watch | Native, exclusively |
| One-off "where am I" | `navigator.geolocation` | Native `location.request` (protocol v2) |
| Route progress, off-route, coasting | Browser engine | Native processor |
| Reroute / replan decisions | Browser | Native |
| Voice cues | `SpeechSynthesis` | Native TTS |
| Get-off alert | Web notification + tone | Native scheduled alert |
| Wake lock | Screen Wake Lock API | Native |
| Durable session | IndexedDB | Native SQLite |
| Transit live refresh | Browser polling | Native, single token consumer |
| Community frontend bundles | Loaded | Never executed |
| Microphone / voice search | Available | Never offered |
| Rendering, search, planning | Web | Web |

The shell's presence is announced by an immutable descriptor injected before any
page script runs. Every row above that says "never" is decided from that
descriptor alone — **not** from the handshake. Waiting for negotiation would
leave a window in which unreviewed code had already executed, and a window is
all it takes.

There are exactly two authorities, `browser` and `native`. `negotiating`,
`incompatible` and `error` are all native states. None of them is permission to
start a browser engine inside an installed app.

## The bridge protocol

Versioned and negotiated, because the web app deploys independently of the store
binary and the two will routinely disagree.

- **v1** — session lifecycle, snapshots, navigation events.
- **v2** — additive: one-shot foreground location, OS settings, deep links,
  system authentication.

A v2 message is never sent to a v1 shell. The client refuses it locally, so an
old-but-working binary reports "this app version cannot do that" rather than
looking like a broken bridge.

### Rollout order

1. Deploy a web app that supports both versions.
2. Ship the native release that adds the new version.
3. Later, deploy a web app that uses the new capability.

At no point is a lockstep store review and web deployment required. For a
breaking schema change the same sequence runs in reverse, with an overlap window
in which both are accepted.

### What crosses, and what does not

Everything is a strict schema with explicit bounds. The bridge carries no cookie,
no session token, no OAuth token, no password, no TOTP secret, no passkey
assertion, no arbitrary URL, no arbitrary JavaScript, and no arbitrary text to
speak or display.

Snapshots are monotonic. A full snapshot is authoritative at any revision — a
reload legitimately produces one from wherever the session had reached. A delta
applies only to the exact revision it was computed from, on the same session and
the same route; anything else asks for a full snapshot instead. A missed update
is a moment of staleness, and an invented one is a puck on the wrong road.

## Fixed origin

The web origin is compiled into the binary. A deep link cannot change it — not
by host, not by port, not by percent-encoding, not by a userinfo segment that
makes one host look like another. Links are canonicalised to an allowlisted
intent (a map query, or "show the running trip") and anything else is discarded
rather than corrected.

Self-hosters change the origin at build time and produce their own signed build
with their own application id, scheme, and link associations. There is no runtime
server switcher, because a server switcher is an origin switcher.

## Authentication

Authentication is web-owned. The app never holds a session.

Email, password, email OTP, verification and TOTP run in the WebView, on the real
origin. They work fine embedded and moving them elsewhere would hand the user off
for the most common case.

OAuth and passkeys do not run in the WebView, because they cannot: providers
increasingly refuse embedded user agents outright, and platform authenticators
are not exposed to a WebView at all. Those operations open the system browser,
per [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252).

### The handoff, and its threat model

The shell generates a 256-bit PKCE verifier and a per-attempt state, in memory,
and opens `https://<compiled origin>/mobile-auth` with only the S256 challenge,
the state, and the purpose. The user signs in on a real page with a real URL bar.
The page then asks the server to issue an opaque callback code, and redirects to
`openmapx://auth/callback` with that code and the state.

What each attacker gets:

- **Another app that registered the same scheme and intercepted the callback.**
  It has the code and no verifier, so it cannot redeem. This is what PKCE is for.
- **Anyone reading the URL** — browser history, an OS intent log, a shoulder.
  The URL carries a code, never a token; the code is single-use and expires in
  two minutes.
- **Anyone who reads the database.** The callback code is stored hashed and the
  verifier is never stored, so a dump yields nothing redeemable.
- **Anyone probing the exchange endpoint.** Every rejection returns the same
  status and body, so no response distinguishes "no such code" from "wrong
  verifier" from "already used". A wrong verifier also consumes the attempt, so
  a live code cannot be ground against.
- **Two racing redemptions.** Consumption is one conditional `UPDATE`; the loser
  matches nothing. There is no read-then-write window.

The exchange returns a Better Auth one-time token, which the WebView immediately
verifies — and that verification, not the exchange, is what sets the WebView's
session cookie. Nothing is retried: an ambiguous exchange means signing in again,
which is cheap, rather than storing a maybe-consumed credential.

On installed iOS there is no third-party primary sign-in at all; OSM and
Mapillary are link/unlink operations on an account the user already has.

## Content Security Policy

Production `script-src` has no `unsafe-inline` and no `unsafe-eval`. The policy
carries a per-request nonce set in `apps/web/src/proxy.ts`; a nonce written into
a static header would be a shared secret an attacker simply reads off the
response.

Two directives are deliberately not tightened:

- `style-src` keeps `unsafe-inline`, because MUI's emotion runtime and MapLibre
  both write style elements at runtime. Inline style cannot execute, so this is
  a bounded exception rather than a hole.
- `connect-src` and `img-src` stay broad, because tiles and data services live on
  origins an operator configures at runtime and enumerating them would break
  self-hosting. This widens nothing the bridge relies on: the shell checks the
  document origin itself, and a permissive `connect-src` gives a page no ability
  to talk to the shell.

Verified against a local production build with a real browser: every script on
the page carries the nonce, the nonce differs per request, and an injected inline
event handler and a foreign frame are both blocked with explicit violation
reports. Note that `strict-dynamic` intentionally lets already-trusted script
create further script — the threat model is parser-inserted markup, which is what
XSS produces.

## What is guaranteed offline, and what is not

**Guaranteed.** A navigation session that started while online continues through
total network loss. The route and its captured transit stop lists are already on
the device, progress is computed locally, cues are spoken locally, and the alert
is already scheduled. Killing or crashing the WebView does not stop it.

**Not guaranteed.** A cold start with no cached page does not show the map. The
web UI is served remotely; the service worker caches opportunistically, and an
opportunistic cache is not a promise. In that state the app says so honestly and
still offers control of the running session through native UI.

That distinction is deliberate and is not a limitation to be quietly engineered
around. Promising an offline cold start would mean shipping the UI in the binary,
which would mean the app and the website diverging at every deploy.

## What is not here

No Median or comparable wrapper service. No EAS or any paid cloud build. No
analytics. No remote push. No over-the-air native update channel. `ios/` and
`android/` are generated build output, regenerated from `app.config.ts` and the
config plugins, and are never committed.
