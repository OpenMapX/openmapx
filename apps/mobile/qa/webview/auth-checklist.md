# WebView authentication qualification

What this covers, and what it deliberately does not.

The system-browser handoff can be qualified almost entirely on simulators and
emulators, because the parts that can go wrong there are the parts we wrote: URL
construction, state matching, single-use consumption, expiry, and what happens
when each step fails. What cannot be qualified there is anything involving a
real platform authenticator, a real identity provider, or a real verified app
link — those depend on hardware, on an Apple/Google association that only
resolves for a shipped bundle identifier, and on provider behaviour we do not
control. Those cases are listed at the bottom as pending, and stay pending until
a volunteer runs them on a device.

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

These are runnable now, on the local Release-configuration build.

### The happy path

- [ ] Tap a sign-in action that routes to the system browser. Confirm a real
      browser opens — a separate UI with a visible URL bar, not an in-app view.
- [ ] Confirm the URL is exactly `https://<compiled origin>/mobile-auth` with
      `purpose`, `state`, `code_challenge` and `code_challenge_method=S256`, and
      nothing else.
- [ ] Complete sign-in in the browser. Confirm the redirect goes to
      `openmapx://auth/callback` and carries only `code` and `state`.
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
      Confirm either a completed sign-in or a clean failure — never a stuck
      spinner.
- [ ] Kill the app mid-attempt and relaunch. Confirm no attempt is resumed and
      the user is asked to sign in again.
- [ ] Reload the WebView between the callback and the exchange. Confirm the
      attempt is abandoned rather than retried.

### Hostile callbacks

Deliver these with `xcrun simctl openurl` / `adb shell am start` while an attempt
is in flight. Each must be ignored, with the app remaining in its waiting state.

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

### Old shells

- [ ] Run a web build against a protocol v1 shell. Confirm sign-in offers
      "sign in using your browser" and says explicitly that the session will not
      carry back — it must not imply a transfer that cannot happen.
- [ ] Confirm no embedded OAuth attempt is made silently in that case.

### Storage hygiene

- [ ] After a completed sign-in, export native diagnostics. Confirm no cookie,
      session token, one-time token, callback code, or verifier appears.
- [ ] Inspect the app's SQLite database. Confirm the same.
- [ ] Confirm the outbox and command-dedupe tables contain no `auth.open` entry:
      an auth attempt is memory-only and must not survive a restart.

## Pending volunteer-beta cases

These cannot be established on a simulator or emulator. They are carried into
the Plan 06 beta matrix and remain open until a volunteer runs them on real
hardware.

- [ ] **Passkey creation and use on a real authenticator.** Simulators do not
      have a real Secure Enclave or a real Android biometric prompt, and the
      failure modes that matter — a cancelled biometric, a passkey synced from
      another device, a security key over NFC — do not occur there.
- [ ] **A real identity provider's consent screen.** Providers behave
      differently for a shipped bundle identifier than for a debug one, and some
      detect and refuse non-browser user agents in ways that only appear in
      production.
- [ ] **Verified App Links / Universal Links.** The OS resolves the association
      against a signed, installed build. Until the app is signed and the
      association file is served from the production origin, a link that appears
      to work locally proves nothing.
- [ ] **The system browser's own session state.** Whether a user is already
      signed in in Safari or Chrome — and whether that browser is set as the
      default — changes what they see, and virtual devices do not reproduce a
      realistic browser profile.
- [ ] **Backgrounding under memory pressure mid-attempt.** A simulator does not
      terminate the app the way a real device under pressure does.
