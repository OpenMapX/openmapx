# Secure shell — scenarios that need a physical device

Everything in this file is **unverified**. These are the behaviours that a
simulator or emulator either cannot reproduce or reproduces dishonestly, so they
are deferred to the volunteer store beta rather than claimed here.

Nothing in this document may be marked verified from a simulator run, a code
review, or an emulator screenshot. A scenario becomes verified only when a named
volunteer reports it from a physical device, with the device, OS version and
build recorded alongside the result.

## Why these cannot be qualified locally

| Behaviour | Why a simulator cannot answer it |
| --- | --- |
| Background location delivery | The simulator never applies a real power policy, never throttles for thermal state, and never suspends the app the way a locked phone does. |
| Locked-screen audio | Route and interruption behaviour depends on the physical audio session and on what else the device is playing. |
| Doze / App Standby (Android) | Emulators do not enter Doze under the same conditions, and OEM battery managers do not exist there at all. |
| OEM permission revocation | Vendor-specific "restrict background activity" behaviour has no emulator equivalent. |
| Force-stop and reboot survival | The emulator's process lifecycle does not match a device under memory pressure. |
| Precise-location downgrade | The simulator grants precise location without the system dialogs a real user sees. |

## Permission matrix

| # | Scenario | Platform | Expected | Status |
| --- | --- | --- | --- | --- |
| P-1 | First start: disclosure appears before any OS dialog | both | Native disclosure precedes every system prompt | unverified |
| P-2 | Grant "When In Use", then accept the "Always" upgrade | iOS | Session runs in background mode | unverified |
| P-3 | Choose "Allow Once" | iOS | Settings route shown; no second prompt is attempted | unverified |
| P-4 | Grant precise = off | iOS 14+ | Settings route with the precise-location explanation | unverified |
| P-5 | Return from Settings having granted Always | iOS | Session upgrades without a new prompt | unverified |
| P-6 | Return from Settings having changed nothing | both | Denied state; Settings is not reopened | unverified |
| P-7 | Grant foreground, decline background | Android 10 | Foreground-only offered explicitly | unverified |
| P-8 | Background permission | Android 11+ | Settings route; no in-app background dialog is attempted | unverified |
| P-9 | Notification permission separate from location | Android 13+ | Location works without notification permission | unverified |
| P-10 | Start while the app is not visible | Android 14+ | Start refused with `app-not-visible`; no service is started | unverified |
| P-11 | Deny with "Don't ask again" | Android | Denied state; no further prompt | unverified |
| P-12 | Revoke permission mid-session from Settings | both | Session stops, alerts cancelled, audio released, no re-prompt | unverified |

## Lifecycle and recovery

| # | Scenario | Platform | Expected | Status |
| --- | --- | --- | --- | --- |
| L-1 | Lock the screen during an active background session | both | Updates continue; the OS location indicator is visible | unverified |
| L-2 | Background the app for 30 minutes | both | Session survives; callback gaps recorded in diagnostics | unverified |
| L-3 | Foreground-only session, app backgrounded | both | Delivery stops immediately; paused state is shown on return | unverified |
| L-4 | Force-stop, then relaunch | Android | Resume/End offered; location is not restarted automatically | unverified |
| L-5 | Reboot, then relaunch | both | Same as L-4 | unverified |
| L-6 | Process recreation under memory pressure | both | Session recovered from SQLite; exactly one stream | unverified |
| L-7 | WebView reload during an active session | both | Native session and driver continue; new handshake receives the authoritative snapshot | unverified |
| L-8 | Airplane mode during an active session | both | Native guidance continues; offline overlay appears only for the page | unverified |
| L-9 | Session left running past 24 hours | both | Session expires, tracking stops, location-bearing rows cleared | unverified |
| L-10 | OEM battery optimisation enabled (Xiaomi, Huawei, Samsung, OnePlus) | Android | Recorded per device; a failure here is expected to differ by vendor | unverified |

## Audio

| # | Scenario | Platform | Expected | Status |
| --- | --- | --- | --- | --- |
| A-1 | Cue while music plays | both | Music ducks, then resumes | unverified |
| A-2 | Cue while the screen is locked | both | Cue is audible | unverified |
| A-3 | Cue during a phone call | both | Cue is skipped, never queued to play afterwards | unverified |
| A-4 | Cue over Bluetooth car audio | both | Routed to the car; recorded per head unit | unverified |

## Storage and privacy

| # | Scenario | Platform | Expected | Status |
| --- | --- | --- | --- | --- |
| S-1 | Stop navigation, then inspect the developer storage dump | both | No active session, no last fix, no route, no token, no alert rows; the terminal acknowledgement holds only ids, status, revision and time | unverified |
| S-2 | Export diagnostics and read the file | both | No coordinates, geometry, stop names, cue text, tokens or URLs | unverified |
| S-3 | Arrive at the destination | both | Same as S-1 | unverified |

## Driver decision

The `LocationDriver` interface exists so that `expo-location` can be replaced
without touching the coordinator, storage, bridge, web UI or engines.

Replacement is triggered **only** by beta evidence: two independent volunteers
reporting the same driver-specific background failure on devices where the same
scenario succeeds with a direct platform API. Until that evidence exists,
`expo-location` remains selected, and its record in
`apps/mobile/qa/assumptions/location-driver.json` stays unresolved.

Simulator and emulator runs cannot trigger this condition and must not be
recorded as if they did.
