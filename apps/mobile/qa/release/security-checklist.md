# Security checklist

Everything here is something an attacker would try, phrased as a thing to do
rather than a property to believe.

## The bridge

- [ ] Send a command with a nonce from a previous document. Expect rejection.
- [ ] Send one with no handshake. Expect rejection.
- [ ] Send one at a protocol version that was not negotiated. Expect rejection.
- [ ] Send the same message id twice. Expect the second to be refused.
- [ ] Send a payload above the message ceiling. Expect refusal before parsing.
- [ ] Send `{"__proto__": {...}}`. Expect refusal, and no polluted prototype.
- [ ] Send a v2 command to a v1 shell. Expect a capability error, not a hang.
- [ ] Address the bridge from an iframe. Expect no channel at all.

## The origin

- [ ] Navigate to a different host. Expect the navigation to be refused.
- [ ] Navigate to `http://` on the right host. Expect refusal.
- [ ] Present a bad certificate. Expect failure, not a bypass prompt.
- [ ] Open a popup. Expect no second in-app browser.
- [ ] Deliver a deep link with userinfo, a wrong port, or an encoded host.
      Expect each to be discarded.

## Content security

- [ ] Inject an inline `<script>` into the served HTML. Expect it blocked.
- [ ] Add an inline event handler. Expect it blocked, with a violation report.
- [ ] Navigate a `javascript:` URL. Expect it blocked.
- [ ] Embed a foreign frame. Expect it blocked.
- [ ] Confirm the production policy contains no `unsafe-inline` or `unsafe-eval`
      in `script-src`, and that the nonce differs per request.

## Authentication

- [ ] Intercept the custom-scheme callback from another app. Confirm the code
      cannot be redeemed without the verifier.
- [ ] Replay a consumed callback code. Expect the same error as an unknown one.
- [ ] Redeem after two minutes. Expect the same error again.
- [ ] Confirm every failure returns an identical status and body.

## Storage

- [ ] After a full session and a sign-in, dump the app's SQLite database.
      Expect no cookie, session token, one-time token, callback code, verifier,
      password, or passkey assertion.
- [ ] Export diagnostics. Expect shapes and reasons, not payloads.
- [ ] Confirm the outbox and dedupe tables carry no `auth.open` entry.

## The binary

- [ ] Confirm the manifest and Info.plist request only the reviewed permissions.
- [ ] Confirm no over-the-air update component is present.
- [ ] Confirm cleartext traffic is not permitted and the app is not debuggable.
- [ ] Confirm no analytics, crash-reporting or advertising SDK is linked.
