# WebView authentication qualification

Use this checklist after connecting `auth.open` to a system-browser adapter in
`src/App.tsx`. The current shell has no command dispatcher and returns
`unsupported-capability`; helper and API tests do not establish this installed
flow. Record that prerequisite as blocked rather than passing the cases below.

Virtual runs can exercise URL construction, state matching, code consumption,
expiry and failures through a composed test build. Real authenticators, provider
consent, signed-app associations and lifecycle behavior need physical evidence.

Record the runtime versions with each run. A pass on one WebView build says
nothing about another.

```
Date:
iOS simulator (version / device):
Android emulator (API level / device):
App version / build:
Web build id (from the handshake):
```

## Virtual-device cases

Run these on a local Release-configuration build after the dispatcher and browser
adapter are composed. They are blocked in the current production composition.

### The happy path

- [ ] Tap a sign-in action that routes to the system browser. Confirm a real
      browser opens with its system authentication UI and visible origin.
- [ ] Confirm the URL is exactly `https://<compiled origin>/mobile-auth` with
      `purpose`, `state`, `code_challenge` and `code_challenge_method=S256`, and
      nothing else.
- [ ] Complete sign-in in the browser. Confirm the redirect goes to
      `<compiled scheme>://auth/callback` and carries only `code` and `state`.
      Development builds use `openmapx-dev`; official releases use `openmapx`.
- [ ] Confirm the app returns to the foreground and the WebView shows a signed-in
      session without a further prompt.
- [ ] Confirm the session survives a WebView reload.

### What must not be in the URL

- [ ] Inspect the callback URL. It must contain no token, no session identifier,
      no email address, and no PKCE verifier.
- [ ] Inspect the `/mobile-auth` URL. It must contain no token and no verifier.

### Cancellation and failure

- [ ] Dismiss the system browser without signing in. Confirm the app reports a
      cancellation and no session appears.
- [ ] Sign in, then background the app before the redirect completes. Return.
      Confirm either completed sign-in or a clean failure, with no stuck spinner.
- [ ] Kill the app mid-attempt and relaunch. Confirm no attempt is resumed and
      the user is asked to sign in again.
- [ ] Reload the WebView between the callback and the exchange. Confirm the
      attempt is abandoned rather than retried.

### Hostile callbacks

Deliver these with `xcrun simctl openurl` / `adb shell am start` while an attempt
is in flight. Use the compiled scheme for the build. Each invalid callback must fail without
establishing a session. Record whether the browser adapter ignores it or returns
a clean failure; the session helper itself returns `failed` for a mismatched URL.

- [ ] `openmapx://auth/callback` with a different `state`.
- [ ] `openmapx://auth/callback` with no `state`.
- [ ] `openmapx://auth/other?code=…&state=…`.
- [ ] `openmapx://elsewhere/callback?code=…&state=…`.
- [ ] `https://openmapx.com/auth/callback?code=…&state=…`.
- [ ] The same valid callback delivered twice.

### Replay and expiry

- [ ] Capture a valid callback code. Redeem it. Confirm a second redemption
      fails and no second session is created.
- [ ] Hold a callback for over two minutes before redeeming. Confirm it fails.
- [ ] Confirm every failure above produces the same user-visible message: the UI
      must not tell the user which part was wrong.

### What stays in the WebView

- [ ] Email + password sign-in runs in the WebView with no browser opening.
- [ ] Email verification and email OTP run in the WebView.
- [ ] TOTP entry and backup codes run in the WebView.
- [ ] Password reset runs in the WebView.

### Platform-specific offerings

- [ ] iOS build: no third-party identity provider is offered as a way to sign in
      or create an account. Confirm by inspecting the sign-in dialog.
- [ ] iOS build: after signing in with email, linking and unlinking OSM and
      Mapillary is available in account settings.
- [ ] Android build: only the reviewed providers appear, and each opens the
      system browser rather than an embedded view.

<a id="old-shells"></a>

### Incompatible shells

- [ ] Use a protocol fixture whose advertised range does not overlap v3. Confirm
      an update is required and no `auth.open` transfer is attempted.
- [ ] Confirm no embedded OAuth attempt is made as a fallback. There is no
      supported v1/v2 pairing in the current compatibility matrix.

### Storage hygiene

- [ ] After a completed sign-in, export native diagnostics. Confirm no cookie,
      session token, one-time token, callback code, or verifier appears.
- [ ] Inspect the app's SQLite database. Confirm the same.
- [ ] Confirm the outbox and command-dedupe tables contain no `auth.open` entry:
      an auth attempt is memory-only and must not survive a restart.

## Pending volunteer-beta cases

Keep physical acceptance open until a volunteer tests the signed candidate.
Virtual fixtures can exercise some of these conditions but do not establish the
complete hardware/provider flow.

- [ ] Create and use passkeys with a real authenticator, including cancelled
      biometrics, a passkey synced from another device and an NFC security key
      where supported.
- [ ] Complete each reviewed provider's real consent flow with the release
      identifier and system browser.
- [ ] Verify App Links/Universal Links against deployed associations and the
      signed installed app.
- [ ] Check existing Safari/Chrome sessions and different default browsers.
- [ ] Background the app under memory pressure mid-attempt and record recovery.
