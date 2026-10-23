<!-- Generated from data-practices.json by store-answers.mts. Do not edit by hand:
     update registry prose or this template and regenerate. --check verifies
     generated-file parity, not behavior, privacy classifications or approval. -->

# Background location declaration

DRAFT: qualification input for a future composed candidate. This is not a
submission-ready declaration, evidence of a store review or proof of compliance.
Review the exact binary, served web/API builds, runtime data flows and privacy
practices, then confirm the current console requirements before submission.

`apps/mobile/src/App.tsx` does not compose the native navigation/permission/effect
ports or system-auth dispatch. The shell reports background navigation, local
notifications and speech unavailable. Existing components and tests do not
establish installed locked-screen or foreground-only guidance.

Check consistent, accurate descriptions in the OS purpose strings, in-app
disclosure, privacy policy, store description, console declaration and reviewer
notes. This generator does not update or verify those other surfaces.

## Intended native behavior

Native components are intended to continue guidance during a user-started session while the screen is locked or the app is backgrounded. App.tsx does not currently compose native navigation, so this behavior is unavailable in the installed shell.

## When it is active

The intended boundary is a navigation session the user explicitly starts.
Verify that starting the session is deliberate, foreground-only mode pauses as
disclosed, and ending, arriving or revoking permission stops background work.
These are qualification requirements for the composed candidate.

## What the user is told, before the OS prompt

Verify that the disclosure explains background location for the user-started
trip, local progress processing, transmitted route/transit requests and the
foreground-only and stop controls. Map/imagery and other enabled web features
have additional data flows; do not claim all coordinates stay on the device.

## Retention

The intended native session uses the same 24-hour maximum age as foreground navigation. Termination removes its location-bearing rows; expiry cleanup requires navigation or recovery execution.

All registry retention, collection, sharing and identity values remain proposals
pending privacy review. Session expiry is not proof of immediate disk deletion.
Review provider retention, deployment logs/backups, transit tokens serialized to
SQLite, and diagnostics without a demonstrated age purge.

## Purpose restrictions to verify

The intended background practice supports active guidance. Verify that the exact
candidate and its providers do not use those fixes for advertising, analytics,
profiling or location history. Inspect binary dependencies and served web code;
the registry cannot establish the absence of tracking or crash reporting.

Apply [Apple's collection and real-time retention definition](https://developer.apple.com/app-store/app-privacy-details/)
and [Google's transmission and ephemeral-processing guidance](https://support.google.com/googleplay/android-developer/answer/10787469)
separately. Google's form includes transmitted data processed ephemerally.
An opaque auth code or short expiry does not approve an exemption; its verifier
reaches the API and its server row is account-linked.

## Demonstrating it for review

After composition and candidate device qualification, record the actual flow:
planning a route, disclosure, OS permission handling, guidance, screen locking,
audible guidance and ending the trip. Cover denial and foreground-only behavior
separately. Use a synthetic or public route, and bind observations to the tested
binary and served web/API builds. Do not present component tests or a script as
device evidence. The current installed shell cannot supply this demonstration.
