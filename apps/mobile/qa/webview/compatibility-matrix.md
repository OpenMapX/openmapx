# Web / native compatibility matrix

The web app deploys continuously; the store binary does not. So every shipped
shell spends its life talking to pages it was not built alongside — older ones
after a rollback, newer ones the day after a deploy. Each pairing must either
work or fail honestly, and no pairing may ever let the browser start a second
navigation engine.

## Where this is enforced

Most of this matrix is executable rather than a table somebody checks by hand:

- `apps/web/src/lib/mobile/runtimeCompatibility.test.ts` — the web app's view of
  negotiation, per-version message availability, and staged rollout.
- `apps/mobile/src/bridge/compatibility.e2e.test.ts` — the current native binary
  against v1, current, and future-only web ranges, through the real bridge.
- `packages/core/src/navigation/mobileProtocol.test.ts` — the vocabulary itself,
  including that v1 messages still parse exactly as they did.

The rows below are the same matrix stated once in prose, for review. Run the
manual column on a virtual device when changing the protocol.

## The matrix

| Native | Web | Navigation | v2 features | Notes |
| --- | --- | --- | --- | --- |
| v1 | v1 | Works | Absent | The original pairing. |
| v1 | v2 | Works | Hidden | The common case after a web deploy. Web must not send v2 messages. |
| v2 | v1 | Works | Hidden | A new binary against a rolled-back page. |
| v2 | v2 | Works | Available | Full behaviour. |
| No overlap | any | **Refused** | Absent | Update required. No browser engine, no partial session. |
| Malformed hello | any | **Refused** | Absent | Channel stays unhandshaken rather than half-open. |

## Staged deployment order

1. Deploy a web app that supports old **and** new.
2. Ship the native release that adds the new version.
3. Later, deploy a web app that uses the new capability.

At no point is a lockstep store review and web deployment required. For a
breaking schema change, run the same sequence in reverse and keep an overlap
window in which both shapes are accepted.

## Manual checks on a virtual device

Run these when the protocol changes, on a local Release build.

- [ ] Point the app at a web build advertising `max: 1`. Confirm navigation
      starts, and that My Location falls back to the browser message rather than
      silently doing nothing.
- [ ] Point it at the current web build. Confirm the v2 features appear.
- [ ] Point it at a web build advertising a range above the shell's. Confirm the
      update-required copy appears, that Start is disabled, and that browsing and
      route planning still work.
- [ ] Reload the WebView during an active session. Confirm a fresh handshake,
      then a full snapshot, then the UI showing the session at its **current**
      revision rather than the one it had before the reload.
- [ ] Deploy a web build with a different build id while a session is running,
      then reload. Confirm the session survives and renegotiates cleanly.
- [ ] Confirm that in every refused case above, no browser geolocation watch, no
      browser voice, and no browser session record appears.

## Pending volunteer-beta cases

- [ ] **A real staged store rollout.** Phased release means a population running
      several binaries at once against one web deployment. Only a real rollout
      produces that distribution.
- [ ] **An old binary that has been installed for months.** Its cached web shell,
      cookies and stored preferences have a history no fresh emulator has.
