# Web / native protocol matrix

The shell and the web client each speak exactly one protocol version (6), and the
page negotiates it on every load. Intake additionally requires the `nativeIntake`
capability. This source matrix does not establish deployed build history. A
pairing built for different versions disables native navigation without allowing a
second browser engine, and the page asks for an app update.

## Where this is enforced

The protocol contracts are covered by:

- `apps/web/src/lib/mobile/runtimeCompatibility.test.ts` covers the web app's view of
  current, previous-only, and future-only ranges.
- `apps/mobile/src/bridge/compatibility.e2e.test.ts` covers the native bridge implementation
  against current and non-overlapping web ranges, through the real bridge.
- `packages/core/src/navigation/mobileProtocol.test.ts` covers the current vocabulary
  and exact request/reply correlation contract.

The composed shell reports actual navigation and optional module capabilities.

## The matrix

| Native | Web        | Handshake | Behavior                                                     |
| ------ | ---------- | --------- | ------------------------------------------------------------ |
| 6      | 6          | 6         | Navigation plus bounded intake when the module is available. |
| 6      | No overlap | Refused   | Update required; no browser navigation fallback.             |
| 6      | Malformed  | Refused   | Channel stays unhandshaken.                                  |

Ship the web build and the rebuilt native app together. Until an installed app is
replaced, the page shows the update prompt. Unopened inbox items expire after 24
hours.

## Manual checks on a virtual device

Run these when the protocol changes. Use a development identity for alternate
local origins; the official release identity is bound to the official origin.
Active-session checks require the normal composed dispatcher.

- [ ] Point the app at a web build advertising a range below v6. Confirm the
      update-required copy appears and that Start is disabled.
- [ ] Point it at the current v6 web build. Confirm v6 is selected and the advertised capabilities match actual
      composition. Capabilities must reflect the composed runtime.
- [ ] Point it at a web build advertising a range above v6. Confirm the
      update-required copy appears, that Start is disabled, and that browsing and
      route planning still work.
- [ ] Reload the WebView during an active session. Confirm a fresh handshake,
      then a full snapshot, then the UI showing the session at its **current**
      revision rather than the one it had before the reload.
- [ ] Deploy a web build with a different build id while a session is running,
      then reload. Confirm the session survives and renegotiates cleanly.
- [ ] Confirm that in every refused case above, no browser geolocation watch, no
      browser voice, and no browser session record appears.
- [ ] Reload during an intake chunk transfer: content remains pending,
      stale replies do not reach the next document, and explicit import can retry.
