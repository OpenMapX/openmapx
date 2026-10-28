<!-- Generated from data-practices.json by store-answers.mts. Do not edit by hand:
     update registry prose or this template and regenerate. --check verifies
     generated-file parity, not behavior, privacy classifications or approval. -->

# Google Play Data safety worksheet

DRAFT: qualification input. Do not transcribe these proposals into Play Console
until the exact candidate binary, served web/API builds, deployment and configured
providers have completed runtime and privacy review. Confirm each answer against
the current console form on the day of submission. This worksheet records no
completed store review or proof of compliance.

`apps/mobile/src/App.tsx` does not compose native navigation or system-auth
dispatch. Installed ground/transit guidance, background location, local alerts
and speech are unavailable. Native component descriptions are intended practices
requiring composition and device qualification.
See [Mobile architecture](../../../docs/docs/developer/mobile-architecture.md).

## Collected and shared

Every category, sharing, handling, required/optional and purpose value below is
a proposal pending review. Rows filtered out by the current registry values must
also be reviewed; their absence does not establish that data is not collected.

| Category | What | Sharing | Handling | Required | Purposes |
| --- | --- | --- | --- | --- | --- |
| Location | Start, destination and waypoint coordinates | Collected only | Processed ephemerally | Required | App functionality |
| Location | Current position submitted for a reroute or replan | Collected only | Processed ephemerally | Required | App functionality |
| Location | Transit origin, destination, departure time, and a rotating refresh token | Collected only | Processed ephemerally | Required | App functionality |
| Personal info | Email address, display name, and authentication credentials | Collected only | Retained | Optional | Account management, App functionality |
| App activity | Saved places, labels, and app preferences | Collected only | Retained | Optional | App functionality |
| App activity | Encrypted local review signing key material and public unlock metadata | Collected only | Retained | Optional | App functionality |
| App activity | Signer session token, provider login information, review content and public signing identity | Shared | Retained | Optional | App functionality |
| App activity | Review text, rating, nickname, photos and public signing identity the user chooses to publish | Shared | Retained | Optional | App functionality |
| Location | Tile and imagery requests revealing the viewed area, with network metadata such as IP address | Shared | Processed ephemerally | Required | App functionality |

## Security practices to verify

- Verify HTTPS for the binary, served web code and every configured provider path.
- Test account-deletion intake in the app and at
  `https://openmapx.com/delete-account`, including access after uninstall.
  Review retained records, backups and processor handling separately.
- Complete binary, runtime and privacy review before approving the form answers.

## Transmission and ephemeral processing (unresolved)

[Google's Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469)
defines collection as off-device transmission, including through an app-controlled
WebView. Transmitted data processed only in memory for the request still belongs
in the form response; qualifying ephemeral handling affects public display.
Apple's real-time retention definition does not decide Google's form answers.

The auth handoff remains marked not collected in the registry pending review,
although the WebView sends code, state and verifier to API `/mobile-auth/exchange`
and the server stores an account-linked handoff row. Its two-minute redemption
window does not establish memory-only handling or an approved exemption.

Local navigation processing, captured stops, alert schedules and diagnostics
components have separate transmission boundaries. Diagnostic export can share a
file deliberately; cookies accompany authenticated requests. Local storage alone
does not establish that the underlying data stays on the device.

## Retention, sharing and identity review

- Provider retention and proposed ephemeral tile/media handling are unverified.
  Check each selected provider and deployment's intermediaries, caches and logs.
- Native transit payloads serialize refresh tokens to SQLite. Diagnostics have
  row/byte limits without a demonstrated 24-hour purge. These facts need review
  against the retained retention classifications and budgets.
- Saved content is readable by the server/operator and can be shared through
  bearer links. Local review keys are encrypted before upload. Shared signing sends
  a session token and review through the API to Mangrove, which holds the signing
  key. Provider login also exposes browser request and login data. Public review
  submissions use an authenticated relay; assess identity linkage separately.
- Sign-out leaves offline downloads and some other browser storage. Verify the
  separate removal controls. Review distributor diagnostics and developer-console
  access before accepting the registry's not-collected proposal for store data.

Use the [user-data trust model](../../../docs/docs/developer/user-data-trust-model.md)
and current Play Console questions to resolve these proposals before submission.

## Location permission declaration

The native components are intended to use background location only during an
active navigation session the user started. Qualify disclosure, permission denial,
foreground-only behavior, locked-screen guidance and stop/revocation handling in
the composed candidate. The current installed shell cannot demonstrate this flow.
