---
title: Mobile store operations
description: Signing material, verified-link setup, beta qualification and recovery.
sidebar_position: 11
---

# Mobile store operations

Use this runbook after the account holder confirms enrollment, legal identity and
store access. The repository records placeholder signing identities and no
physical beta reports. It does not establish current external account, upload or
review status. Resolve the composition and build-input blockers in
[Mobile release](./mobile-release.md) before preparing a store candidate.

## What lives where

| Material                                  | Storage                                                   | Commit to Git?     |
| ----------------------------------------- | --------------------------------------------------------- | ------------------ |
| Apple Team ID and application identifier  | `apps/mobile/release/public-signing-identities.json`      | Yes, public values |
| Play app-signing SHA-256 fingerprint      | Same file                                                 | Yes, public value  |
| Apple certificate and private key         | macOS Keychain and encrypted offline `.p12` recovery copy | Never              |
| Provisioning profiles                     | Local signing setup                                       | Never              |
| Android upload keystore and passwords     | Encrypted password manager and two tested offline backups | Never              |
| Store API keys and app-specific passwords | Keychain or approved secret storage                       | Never              |
| Reviewer credentials                      | Password manager; enter directly in the store console     | Never              |

`public-signing-identities.json` has `status: "pending-enrollment"`, `TEAM_ID` and
`REPLACE_WITH_SHA256_FINGERPRINT`. Replace them only with verified public values.
Its account-status note is not an external account inventory.

`assert-store-links.mts` reports placeholders as **pending and exits 0** when
there are no structural errors. Read the output: a successful exit does not
establish verified links or enrollment, and `release:prepare` does not turn that
pending result into a failure.

## Verified links

The committed association files live in
`services/well-known/config/html/`. The Apple file claims `/`,
`/navigation/active` and `/mobile-auth`, plus `webcredentials`. The Android file
names `org.openmapx.app` and its app-signing certificate fingerprint. Keep those
files and the recorded public identities consistent.

### The fingerprint that catches people out

Use the **app-signing key certificate** from Play Console for App Links. The
upload key signs the bundle submitted to Google; it is a different identity from
the certificate on the delivered app. Record and label both fingerprints. The
validator rejects matching upload/app-signing values when both are supplied.

### Validating

Run from the repository root:

```bash
# Inspect committed files without contacting production.
pnpm -C apps/mobile exec tsx scripts/assert-store-links.mts \
  --local ../../services/well-known/config/html

# After deploying real identities, inspect the HTTPS responses.
pnpm -C apps/mobile exec tsx scripts/assert-store-links.mts
```

The network form rejects redirects, non-success responses and content types that
do not contain `application/json`. It then checks content against the recorded
identities. It does not prove that an OS has accepted the associations.

With the signed Android app installed, inspect platform verification:

```bash
adb shell pm verify-app-links --re-verify org.openmapx.app
adb shell pm get-app-links org.openmapx.app
```

For Apple, inspect
`https://app-site-association.cdn-apple.com/a/v1/openmapx.com` and test cold and
warm links on a physical device. Confirm the installed app actually handles the
resulting intent; parsers and valid association files alone are insufficient.

## The Android upload-key ceremony

1. Confirm Play App Signing and its recovery process in the actual app record.
2. Generate a dedicated upload key locally:

   ```bash
   keytool -genkeypair -v -keystore openmapx-upload.jks \
     -alias openmapx-upload -keyalg RSA -keysize 4096 -validity 10000
   ```

3. Store the keystore/passwords encrypted and make two offline backups on
   separate media. Test restoring a backup and signing with it.
4. Record the upload certificate and Play app-signing fingerprints separately.
5. Configure the external mode-`0600` properties file described in
   [Mobile release](./mobile-release.md#prerequisites). Confirm generated Gradle
   configuration consumes it and inspect the signed output. Copying the file
   alone does not establish signing.

If the upload key is lost, use the app record's upload-key reset process. Do not
replace the delivered app-signing identity or change association files to an
unrelated certificate as a workaround.

## Apple signing recovery

1. Create the distribution certificate under the correct team and keep its
   private key in the macOS Keychain.
2. Export an encrypted `.p12` recovery copy, store it offline and test importing
   it on a second trusted machine.
3. Configure local signing and provisioning for the device archive.
4. Record certificate revocation and profile-regeneration steps. After a
   revocation, replace affected profiles and inspect a newly signed artifact.

## Capabilities to enable, and to leave alone

The reviewed iOS entitlement surface uses Associated Domains. Keep unused
capabilities, including push, iCloud, Sign in with Apple, App Groups, HealthKit
and CarPlay, disabled. Compare generated entitlements and the final archive with
`compliance/permissions.ts`; do not infer them from a console checkbox alone.

## What no script here does

The scripts do not enroll an account, accept agreements, upload a build, submit
for review or publish a listing. The account holder reviews those actions and the
actual candidate, disclosures and evidence separately.

## Beta, then rollout

### 1. Qualify the candidate locally

Complete `apps/mobile/qa/release/matrix.md` on its required virtual paths. Missing
foreground composition or a reproducible functional failure blocks beta upload.
Use `pending-physical` only for cases a virtual device cannot establish, never
for an unrun virtual case. A changed candidate needs a new build number and the
affected plus core checks rerun.

A qualifying report permits beta upload only. It does not authorize store
submission or public rollout.

### 2. Upload to a beta track

Use TestFlight or Play internal/closed testing after local sign-off. Retain the
uploaded artifact hash and the store's processed version/build identity. Stores
may transform, thin or re-sign delivery packages; where a processed binary hash
can be obtained, record it and how it was obtained. Do not substitute the uploaded
hash as proof of the installed bytes or invent a hash that cannot be retrieved.

For a new personal Play account, check the console's production-access criteria.
The project's review checklist includes a closed test of at least 12 continuously
opted-in testers for 14 days; the account holder must confirm the current rule
and eligibility before scheduling production access.

### 3. Collect volunteer evidence

Collect sanitized reports for current-iOS iPhone, API 36 Pixel-class Android and
a recent Samsung with default battery management. Follow
`apps/mobile/qa/results/beta/README.md` and the ground, transit and secure-shell
scenarios. Resolve every hardware risk before changing the driver decision to
`beta-qualified` or allowing public rollout. Missing reports remain blockers.

### 4. Submit

Review store notes, privacy answers, declarations, artwork and the actual installed
behavior together. The current reviewer notes are preparation checklists, not
claims ready to submit. Freeze the reviewed web build for the review period so
reviewers see the qualified UI and protocol pairing.

### 5. Roll out conservatively

Start with a limited rollout and review crash/ANR reports, background-guidance
failures by device family and bridge handshake failures against the recorded beta
budgets. The committed first-candidate pairing is protocol v3 only. A later
release must define its tested overlap with actually deployed versions.

### Halting

Use the store's staged/phased-release controls to stop further distribution.
Already updated users keep the installed build. Prepare a corrected candidate
with higher version/build values; a halt does not restore an older binary.

## The native maintenance loop

- Upgrade Expo and React Native deliberately, outside candidate qualification.
  Regenerate and compare permissions, entitlements and the native surface.
- Check store target-SDK deadlines before planning an Android release.
- Inspect every bundled native library for 16 KiB page-size support after
  dependency changes; test with compatibility mode disabled.
- Derive protocol changes from the deployed-version matrix.
- Revalidate association files and device links after service or signing changes.
