<!-- Generated from data-practices.json by store-answers.mts. Do not edit by hand:
     change the registry and regenerate, so the policy, the labels and the code
     keep saying the same thing. -->

# Apple App Privacy worksheet

Transcribe these into App Store Connect → App Privacy. The account holder is
responsible for confirming each answer against the current official questions on
the day of submission; this file records what the app actually does.

## Does this app collect data?

**Yes.** Not because most navigation data leaves the device — it does not — but
because route requests, account details and saved places do. Answering "no" on
the strength of on-device processing alone would be false.

## Data types collected

| Category | What | Purposes | Linked to identity | Used for tracking |
| --- | --- | --- | --- | --- |
| Precise Location | Start, destination and waypoint coordinates | App Functionality | No | No |
| Precise Location | Current position, sent once when a reroute or replan is needed | App Functionality | No | No |
| Precise Location | Transit origin, destination, departure time, and a rotating refresh token | App Functionality | No | No |
| Contact Info | Email address, display name, and authentication credentials | App Functionality | Yes | No |
| Other Data | Saved places, labels, and app preferences | App Functionality | Yes | No |
| Other Data | Review signing key material | App Functionality | Yes | No |
| User Content | Review text and rating the user chooses to publish | App Functionality | No | No |
| Coarse Location | Tile and imagery requests, which reveal the area being viewed | App Functionality | No | No |

## Tracking

**No.** The app contains no analytics SDK, no advertising identifier, no crash
reporter, and no cross-app or cross-site measurement of any kind. `NSPrivacyTracking`
is `false` and there are no tracking domains.

## Data that leaves the device but is not declared as collected

Each of these relies on Apple's documented real-time-processing exception. The
reason is stated so the claim can be checked rather than taken on trust.

- **A single-use callback code and a per-attempt PKCE verifier** — The code is opaque, single-use and expires in two minutes; it identifies one sign-in attempt rather than a person, and the verifier it is useless without never leaves the device.
- **Install, crash and delivery data collected by Apple and Google** — Declared here so the registry is complete, and deliberately not declared as app-collected: the app neither requests nor receives it.

## Location, specifically

The app requests **Always** location only to continue guidance on a trip the
user explicitly started, while the screen is locked or the app is backgrounded.
It is never used to build a location history, is never transmitted continuously,
and stops when the trip ends. Coordinates leave the device only to compute a
route the user asked for, or to compute a new one after they have left the
previous route.
