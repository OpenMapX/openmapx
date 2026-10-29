# Release-candidate qualification matrix

Complete the virtual cases before beta upload. Physical cases remain open until
tested on the processed store build. Bind each report to source, configuration,
web build and artifact identity using the release-candidate schema.

The current foreground shell lacks navigation and auth command composition.
Signing identities are placeholders and native version/signing inputs need
verification. These are candidate blockers, not `pending-physical` outcomes. See
`docs/docs/developer/mobile-release.md` and `qa/results/beta/README.md`.
Remove the root `$comment` and all placeholder outcomes from `rc-template.json`
before using it; it is not a completed or schema-valid evidence report.

## Pre-beta virtual matrix

| Path                                                               | Why it is here                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Current iOS simulator                                              | The version most users will be on                                  |
| Minimum-target iOS simulator (16.4) where Xcode supplies one       | The oldest supported OS, where layout and API availability diverge |
| Android API 36 emulator                                            | The target SDK                                                     |
| Android API 24 emulator                                            | The minimum SDK                                                    |
| Android 16 KiB page-size emulator, compatibility mode **disabled** | Exercise bundled native libraries without a compatibility fallback |
| Small-screen and tablet layout smoke                               | Not to claim tablet support, but to confirm nothing is unreachable |

## Volunteer target matrix (blocks public rollout, not beta upload)

- One current-iOS iPhone.
- One Android 16 / API 36 Pixel-class device.
- One recent Samsung device with **default** battery management . Record the actual power settings used.

## Functional, lifecycle and offline

Run each on every virtual path. Reset permissions and app data between
permission scenarios; a granted permission carried over silently invalidates the
next one.

- [ ] Fresh launch shows no location prompt.
- [ ] The WebView loads the compiled origin and nothing else.
- [ ] Map, search and route planning work.
- [ ] One-shot location centres the map; a denial degrades honestly.
- [ ] Ground Start: disclosure → prompt → session → authoritative snapshot.
- [ ] Transit Start: captures fetched, then session, then snapshot.
- [ ] Disclosure denied: the app keeps working and says what is lost.
- [ ] Foreground-only granted: guidance runs and pauses at lock, as stated.
- [ ] Injected background and interruption states advance the session.
- [ ] A GPS gap coasts, then recovers, without inventing progress.
- [ ] Reroute and replan work online and are refused offline with a reason.
- [ ] Captured route continues with all networking disabled.
- [ ] The alight alert is scheduled, and cancelled when the leg ends.
- [ ] Killing the WebView renderer leaves guidance running.
- [ ] Reload reconciles from a native full snapshot at the current revision.
- [ ] Deep links: cold, warm, duplicate, and hostile.
- [ ] Route replacement mid-trip preserves guidance until acknowledged.
- [ ] Arrival and End both clean up: no stream, no notification, no session.
- [ ] A session older than 24 hours expires rather than resuming.
- [ ] Revoking permission mid-trip is handled, not crashed.
- [ ] 30-minute and 60-minute deterministic trace replays.
- [ ] One accelerated multi-hour soak.

**Pending physical**: real OS suspension, incoming calls, Bluetooth audio
routing, locked-screen notification delivery, battery drain, thermal state.

## Auth, account and privacy

- [ ] The whole app works with no account.
- [ ] Email signup, verification, password reset and TOTP run in the WebView.
- [ ] The system-browser handoff completes once and only once.
- [ ] iOS offers no third-party provider as a primary sign-in.
- [ ] Provider link/unlink is available on an authenticated account.
- [ ] Android shows only reviewed providers, each in the system browser.
- [ ] Handoff interception, replay and expiry all fail identically.
- [ ] The session survives a WebView reload; logout clears it.
- [ ] In-app deletion and the public `/delete-account` page both work.
- [ ] Diagnostics export contains no cookie, token, code or verifier.
- [ ] Native storage after End, deletion and uninstall contains no session.

**Pending physical**: passkey creation on real hardware, a real provider's
consent screen, verified App Links.

## Security and network

- [ ] Hostile links, wrong origins, and bad certificates are refused.
- [ ] Iframes and popups cannot address the bridge.
- [ ] A wrong nonce, version or revision is rejected with the right code.
- [ ] Oversized and prototype-polluting payloads are refused before parsing.
- [ ] A same-origin community integration is never executed in the shell.
- [ ] CSP fixtures: inline script, inline handler, `javascript:`, foreign frame.
- [ ] IPv6-only, proxied and captive-portal networks degrade honestly.
- [ ] Server downtime and an incompatible deploy show the right message.

## Accessibility, localisation and layout

- [ ] VoiceOver and TalkBack reach every WebView and native overlay control.
- [ ] Dynamic Type and browser text zoom at the largest sizes.
- [ ] Screen zoom, bold text, reduced motion.
- [ ] Dark, light and high-contrast.
- [ ] Nothing is conveyed by colour alone.
- [ ] Switch and keyboard focus order is sensible.
- [ ] Touch targets meet the project targets of 44 pt / 48 dp.
- [ ] English and German: no truncation, correct plurals, permission strings fit.
- [ ] RTL does not corrupt controls, even though no RTL locale ships.

Do **not** claim an App Store Accessibility Nutrition Label category without
passing its current criteria in full.

## Budgets recorded pre-beta

Cold and warm launch to usable UI, Start acknowledgement, snapshot render,
deterministic callback gaps, cue-intent latency and duplication, WebView memory
and renderer recovery, download and install size, crashes and ANRs, and
stop-to-zero-mutation time.

Do not use simulator measurements to qualify physical battery drain, thermal
state or spoken-cue latency. Leave those hardware results open for beta testing.

## Sign-off

Reports for one candidate must reference the same source and configuration.
Required virtual cases must pass. Use `pending-physical` only for a hardware case
that virtual testing cannot establish, never an unrun virtual case. The schema
also allows `not-applicable`; explain each exclusion and have it reviewed. A single `fail` requires a
new build number, newly built artifacts, and a rerun of the affected plus core
gates.

Passing authorises **beta upload only**. Not store submission, and not rollout.
