# Web / native protocol matrix

The committed shell, web protocol constants and release descriptor support v3
only. This repository matrix does not establish live deployment history. A page advertising any other range must fail
honestly, and no refused pairing may ever let the browser start a second
navigation engine. A future release may introduce an overlap window once an
older deployed binary actually exists.

## Where this is enforced

The protocol contracts are covered by:

- `apps/web/src/lib/mobile/runtimeCompatibility.test.ts` covers the web app's view of
  current, previous-only, and future-only ranges.
- `apps/mobile/src/bridge/compatibility.e2e.test.ts` covers the native bridge implementation
  against current and non-overlapping web ranges, through the real bridge.
- `packages/core/src/navigation/mobileProtocol.test.ts` covers the current vocabulary
  and exact request/reply correlation contract.

Run the manual checks on a composed virtual-device build when changing the
protocol. A compatible handshake does not establish that navigation is available:
`src/App.tsx` currently reports every navigation capability false.

## The matrix

| Native | Web             | Handshake   | Notes                                                   |
| ------ | --------------- | ----------- | ------------------------------------------------------- |
| v3     | v3              | Negotiates  | Navigation also requires composed capabilities.         |
| v3     | Previous-only   | **Refused** | Update required. No browser engine, no partial session. |
| v3     | Future-only     | **Refused** | Update required. No browser engine, no partial session. |
| v3     | Malformed hello | **Refused** | Channel stays unhandshaken rather than half-open.       |

## Future version changes

Do not add compatibility machinery speculatively. Once a v3 binary is deployed,
a later protocol change must define its concrete overlap window, tests, and
deployment order from the capabilities of those real releases.

## Manual checks on a virtual device

Run these when the protocol changes. Use a development identity for alternate
local origins; the official release identity is bound to the official origin.
Active-session checks require a composed dispatcher and remain blocked in the
current app.

- [ ] Point the app at a web build advertising a range below v3. Confirm the
      update-required copy appears and that Start is disabled.
- [ ] Point it at the current v3 web build. Confirm v3 is selected and the advertised capabilities match actual
      composition. The current app must report navigation unavailable.
- [ ] Point it at a web build advertising a range above v3. Confirm the
      update-required copy appears, that Start is disabled, and that browsing and
      route planning still work.
- [ ] Reload the WebView during an active session. Confirm a fresh handshake,
      then a full snapshot, then the UI showing the session at its **current**
      revision rather than the one it had before the reload.
- [ ] Deploy a web build with a different build id while a session is running,
      then reload. Confirm the session survives and renegotiates cleanly.
- [ ] Confirm that in every refused case above, no browser geolocation watch, no
      browser voice, and no browser session record appears.
