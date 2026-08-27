# Web / native protocol matrix

There is no deployed OpenMapX mobile release yet, so the first shell and web app
implement protocol v3 only. A page advertising any other range must fail
honestly, and no refused pairing may ever let the browser start a second
navigation engine. A future release may introduce an overlap window once an
older deployed binary actually exists.

## Where this is enforced

Most of this matrix is executable rather than a table somebody checks by hand:

- `apps/web/src/lib/mobile/runtimeCompatibility.test.ts` — the web app's view of
  current, previous-only, and future-only ranges.
- `apps/mobile/src/bridge/compatibility.e2e.test.ts` — the current native binary
  against current and non-overlapping web ranges, through the real bridge.
- `packages/core/src/navigation/mobileProtocol.test.ts` — the current vocabulary
  and exact request/reply correlation contract.

The rows below are the same matrix stated once in prose, for review. Run the
manual column on a virtual device when changing the protocol.

## The matrix

| Native | Web | Navigation | Notes |
| --- | --- | --- | --- |
| v3 | v3 | Works | The first release pairing. |
| v3 | Previous-only | **Refused** | Update required. No browser engine, no partial session. |
| v3 | Future-only | **Refused** | Update required. No browser engine, no partial session. |
| v3 | Malformed hello | **Refused** | Channel stays unhandshaken rather than half-open. |

## Future version changes

Do not add compatibility machinery speculatively. Once a v3 binary is deployed,
a later protocol change must define its concrete overlap window, tests, and
deployment order from the capabilities of those real releases.

## Manual checks on a virtual device

Run these when the protocol changes, on a local Release build.

- [ ] Point the app at a web build advertising a range below v3. Confirm the
      update-required copy appears and that Start is disabled.
- [ ] Point it at the current v3 web build. Confirm the full native feature set.
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
