# App Review notes: Apple

<a id="app-review-notes--apple"></a>

Preparation status: **not ready to submit**. `src/App.tsx` does not connect
navigation or system-authentication commands to native implementations. The
bridge reports all navigation capabilities false. Public signing identities are
placeholders, and no physical beta report is committed. Do not paste proposed
background-navigation claims into App Store Connect until the candidate passes
those requirements.

Keep reviewer credentials in the password manager and enter them directly in
App Store Connect. Never put them in this file or a public report.

## Confirm before writing the submission notes

- Record the exact IPA, source commit, installed version/build and frozen web
  build. Inspect actual signing, permissions, entitlements and version fields.
- Verify map browsing, search and the qualified navigation flow while signed out.
  Account settings and saved account data can require sign-in.
- Describe the WebView as the product UI at the compiled origin. List only native
  capabilities that are composed and observed on the candidate.
- Check the generated privacy worksheet against the current console questions
  and actual data flows, including route requests, accounts and saved places.
- Verify the iOS sign-in policy: no third-party primary sign-in, with
  OpenStreetMap/Mapillary linking available only after account sign-in.
- Complete physical background, audio, alert and recovery qualification. Link the
  resulting sanitized evidence in the private review submission where appropriate.

## Reviewer steps to verify on the candidate

After composition and qualification, test these steps before supplying them:

1. Open the app and confirm no location permission request appears at launch.
2. Search a public destination, choose Directions and tap Start.
3. Read the prominent disclosure before granting location. Check both the
   background and foreground-only choices.
4. Lock the screen and record actual location delivery and spoken guidance.
5. Return and tap End. Confirm location and scheduled alerts stop and storage is
   cleaned.

Do not claim these steps work from helper tests alone. A foreground-only grant
must report its background limitation. Force quit ends guidance; do not promise
that iOS relaunches it automatically.

## Security and offline wording

The source restricts WebView navigation to the compiled origin, disables camera,
microphone and WebView geolocation, and exposes a bounded bridge vocabulary.
Community frontend runtime code is disabled in both the installed app and the web
host. There is no native OTA update channel in the release design. The remotely
served web UI still changes when that web build is deployed, so freeze it during
review.

Captured-route processing tests do not establish installed offline guidance.
After qualification, describe only observed continuity and callback limits.
There is no guaranteed offline cold-start map when the remote page is uncached.
Check native recovery controls in that state and avoid claims of fully offline
maps or force-quit survival.

Use `qa/release/store-review-checklist.md` for the final submission review.
