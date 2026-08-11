# Store review readiness checklist

The things a reviewer actually checks, in the order they usually check them.

## Both stores

- [ ] The app works without an account. A reviewer who cannot get past a login
      wall rejects the app, and "no login required" must be true, not aspirational.
- [ ] The description matches what the app does. No "fully offline maps", no
      "works after force quit", no tablet or car claims.
- [ ] Support, privacy, terms and account-deletion URLs all resolve without a
      login, a redirect, or an error, on an external network.
- [ ] Every permission the app requests is used, visibly, in a flow a reviewer
      can reach.
- [ ] The prominent disclosure appears **before** the OS prompt, and says the
      same thing as the store listing and the privacy policy.

## Apple

- [ ] The WebView is the product UI, and the review notes explain what the
      native code contributes: background location, headless ground and transit
      processing, native session continuity, audio focus and speech, local
      alerts, verified links, and recovery.
- [ ] No third-party provider is offered as a primary sign-in.
- [ ] Account deletion is reachable in the app.
- [ ] `ITSAppUsesNonExemptEncryption` is answered from the actual archive, not
      guessed from package names.
- [ ] The age-rating questionnaire, content-rights and DSA answers are current.
- [ ] Reviewer credentials, if any, are entered in App Store Connect — never in
      a file in this repository.

## Google

- [ ] The background-location declaration, the video, the disclosure copy, and
      the privacy policy all describe the same behaviour in the same words.
- [ ] The video shows: opening the app, choosing a route, the full disclosure,
      both grant and deny paths, the OS prompt, guidance while minimised and
      locked, the ongoing notification, and End cleanup.
- [ ] Data safety answers match `compliance/data-practices.json`.
- [ ] The deletion URL is the public one, not an in-app-only path.
- [ ] Ads: no. Target audience and content rating completed.
- [ ] A new personal account has completed its closed test: at least 12 testers
      continuously opted in for 14 days.

## Before submitting

- [ ] The uploaded artifact's SHA-256 matches the one in the release manifest.
- [ ] The reviewed web build is frozen for the duration of review — a deploy
      mid-review changes what the reviewer sees.
- [ ] Old protocol support is retained through rollout.
