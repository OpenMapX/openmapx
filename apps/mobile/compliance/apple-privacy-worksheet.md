<!-- Generated from data-practices.json by store-answers.mts. Do not edit by hand:
     update registry prose or this template and regenerate. --check verifies
     generated-file parity, not behavior, privacy classifications or approval. -->

# Apple App Privacy worksheet

DRAFT: qualification input. Do not transcribe these proposals into App Store
Connect until the exact candidate binary, served web/API builds, deployment and
configured providers have completed runtime and privacy review. Confirm the
answers against the current console questions on the day of submission. This
worksheet records no completed store review or proof of compliance.

`apps/mobile/src/App.tsx` creates the shell bridge without native navigation
or system-auth dispatch. Ground/transit guidance, background location, local
notifications and speech are reported unavailable. Component behavior below
describes intended native practices, not working installed-shell features.
See [Mobile architecture](../../../docs/docs/developer/mobile-architecture.md).

## Does this app collect data?

Proposed answer: Yes. The registry includes transmitted route inputs, account
details and saved content. All category, purpose, identity and tracking values
below remain pending review; omitted rows do not establish an exemption.

## Data types collected

| Category | What | Purposes | Linked to identity | Used for tracking |
| --- | --- | --- | --- | --- |
| Precise Location | Start, destination and waypoint coordinates | App Functionality | No | No |
| Precise Location | Current position submitted for a reroute or replan | App Functionality | No | No |
| Precise Location | Transit origin, destination, departure time, and a rotating refresh token | App Functionality | No | No |
| Contact Info | Email address, display name, and authentication credentials | App Functionality | Yes | No |
| Other Data | Saved places, labels, and app preferences | App Functionality | Yes | No |
| Other Data | Encrypted local review signing key material and public unlock metadata | App Functionality | Yes | No |
| Other Data | Signer session token, provider login information, review content and public signing identity | App Functionality | Yes | No |
| User Content | Review text, rating, nickname, photos and public signing identity the user chooses to publish | App Functionality | No | No |
| Coarse Location | Tile and imagery requests revealing the viewed area, with network metadata such as IP address | App Functionality | No | No |

## Tracking

Proposed answer: No. Verify the exact binary's dependencies and privacy manifests,
the served web code and provider behavior against Apple's tracking definition.
A declared `NSPrivacyTracking: false` does not establish runtime behavior.

## Transmitted data currently marked not collected (unresolved)

Under [Apple's collection definition](https://developer.apple.com/app-store/app-privacy-details/),
off-device access beyond the time needed to service the request in real time
counts as collection. Short expiry, hashing and an opaque code do not establish
that condition. Review server rows, logs, backups and partner retention.

The following retained registry values are unresolved proposals. No real-time
exemption has been approved here, including for distributor operational data.

- A single-use callback code and a per-attempt PKCE verifier: UNRESOLVED proposal, not an approved exemption. The verifier is transmitted to the API and the server row is account-linked. An opaque code and short redemption lifetime do not establish Apple real-time-only retention or Google ephemeral handling.
- Install, crash and delivery data collected by Apple and Google: Pending review of distributor handling, developer access and the exact binary SDK inventory. The retained not-collected values do not establish a real-time-processing exemption or prove that the operator receives no store diagnostics.

## Location, specifically

Native permission and navigation components are intended to request background
location for a user-started trip, process progress locally and stop on termination.
The current installed shell does not compose that flow or a foreground-only
navigation alternative. Qualify both permission modes on the candidate device.
Route/transit requests transmit inputs; map and imagery requests reveal viewed
areas. Review other enabled web features before describing all location uses.

## Review required before submission

- The auth handoff sends the verifier through `auth.result` to the WebView and
  then to API `/mobile-auth/exchange`. Server rows contain an account ID;
  redemption expiry and eventual row deletion are different events.
- Saved places are readable by the server/operator and can be shared by bearer
  link. Local review keys are encrypted before upload. Shared signing sends a
  session token and review content through the API to Mangrove, which holds the
  signing key. Provider login also exposes browser request and login data. Public
  submissions use an authenticated relay, so identity linkage needs review.
- Sign-out does not clear every cache or downloaded offline area. Review local
  storage, cookie transmission and deletion controls separately.
- Provider retention is unverified. The proposed ephemeral values also need
  review for transit tokens serialized into native SQLite and diagnostics whose
  storage is limited by size without a demonstrated 24-hour purge.

Use the [user-data trust model](../../../docs/docs/developer/user-data-trust-model.md)
to review readers and storage. Complete candidate runtime/privacy qualification
and current App Store Connect review before approving any console answers.
