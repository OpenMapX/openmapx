# Web / native protocol matrix

The shell and new web client support protocols 3–4. Navigation retains protocol 3;
intake requires selected protocol 4 plus `nativeIntake`. This source matrix does
not establish deployed build history. A non-overlapping pairing disables native
navigation without allowing a second browser engine.

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

| Native | Web             | Handshake | Behavior                                                                    |
| ------ | --------------- | --------- | --------------------------------------------------------------------------- |
| 3      | 3–4             | 3         | Existing navigation; no intake commands.                                    |
| 3–4    | 3               | 3         | Navigation and pre-hello snapshots/events use 3; intake capability omitted. |
| 3–4    | 3–4             | 4         | Navigation plus bounded intake when the module is available.                |
| 3–4    | No overlap      | Refused   | Update required; no browser navigation fallback.                            |
| 3–4    | Malformed hello | Refused   | Channel stays unhandshaken.                                                 |

Deploy compatible web first, then ship rebuilt native apps. Older web builds
retain navigation and receive a native notice about pending content. They do not
drain the inbox. Unopened items expire after 24 hours.

## Manual checks on a virtual device

Run these when the protocol changes. Use a development identity for alternate
local origins; the official release identity is bound to the official origin.
Active-session checks require the normal composed dispatcher.

- [ ] Point the app at a web build advertising a range below v3. Confirm the
      update-required copy appears and that Start is disabled.
- [ ] Point it at the current v3–4 web build. Confirm v3 is selected and the advertised capabilities match actual
      composition. Capabilities must reflect the composed runtime.
- [ ] Point it at a web build advertising a range above v4. Confirm the
      update-required copy appears, that Start is disabled, and that browsing and
      route planning still work.
- [ ] Reload the WebView during an active session. Confirm a fresh handshake,
      then a full snapshot, then the UI showing the session at its **current**
      revision rather than the one it had before the reload.
- [ ] Deploy a web build with a different build id while a session is running,
      then reload. Confirm the session survives and renegotiates cleanly.
- [ ] Confirm that in every refused case above, no browser geolocation watch, no
      browser voice, and no browser session record appears.

- [ ] With protocol 3, share nine items: existing navigation remains usable,
      content quota stays at eight, and overflow has an explanatory native notice.
- [ ] With protocol 4, reload during a chunk transfer: content remains pending,
      stale replies do not reach the next document, and explicit import can retry.
