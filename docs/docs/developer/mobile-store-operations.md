---
title: Mobile store operations — signing, associations, and recovery
description: The key ceremonies, verified-link setup, and recovery procedures for the OpenMapX mobile app, and what must never enter the repository.
sidebar_position: 11
---

# Mobile store operations

Everything here is about material the repository must never contain, and the
procedures that keep it recoverable anyway. Losing an Android upload key is
recoverable; losing it *without a documented recovery path* means an app that can
never be updated again under the same listing.

## What lives where

| Material | Where it lives | In Git? |
| --- | --- | --- |
| Apple Team ID, application identifier | `apps/mobile/release/public-signing-identities.json` | Yes — published by the app itself |
| Play app-signing SHA-256 fingerprint | Same file | Yes — published in the Play Console |
| Apple distribution certificate + private key | macOS Keychain, plus one encrypted offline `.p12` | **Never** |
| Provisioning profiles | Xcode-managed locally | **Never** |
| Android upload keystore + passwords | Encrypted password manager, plus two tested offline backups | **Never** |
| App Store Connect API key / app-specific password | Keychain | **Never** |
| Reviewer credentials | Password manager, entered directly into the console | **Never** |

`apps/mobile/release/public-signing-identities.json` currently holds
placeholders. That is the honest state: neither store account exists, so no
identity has been issued. `assert-store-links.mts` recognises the placeholders
and reports "not yet issued" rather than passing — the check must not be able to
report success on a configuration that would silently fail to verify.

## Verified links

Two files decide whether tapping an `openmapx.com` link opens the app. They fail
quietly: the OS fetches each once, decides, and moves on, so a mistake costs a
release and nothing in the app reports it.

`services/well-known/config/html/apple-app-site-association` claims exactly three
paths — `/`, `/navigation/active`, and `/mobile-auth` — and declares
`webcredentials` so passkeys can be associated with the domain. No wildcard: a
link that opens an unreviewed screen is a link nobody checked.

`services/well-known/config/html/assetlinks.json` names `org.openmapx.app` and
one certificate fingerprint.

### The fingerprint that catches people out

Android App Links verify against the certificate **Google** signs the delivered
app with, not the upload key you sign the bundle with. Both are 64 hex
characters and nothing about the value distinguishes them, so using the upload
key's fingerprint produces links that never verify and no error anywhere.

Take the value from Play Console → Setup → App signing → **App signing key
certificate**, not the upload key certificate below it. The validator refuses a
configuration where the two match.

### Validating

```bash
# Against the committed files
pnpm -C apps/mobile exec tsx scripts/assert-store-links.mts \
  --local ../../services/well-known/config/html

# Against production, which is the only way to catch a redirect, a login wall,
# or a CDN serving the wrong content type
pnpm -C apps/mobile exec tsx scripts/assert-store-links.mts
```

The production form fetches with `redirect: "error"`, because both platforms
refuse a redirected association file — following one would report a pass the OS
will not agree with.

After deploying, verify from the platforms' own side:

```bash
adb shell pm verify-app-links --re-verify org.openmapx.app
adb shell pm get-app-links org.openmapx.app
```

For Apple, check the CDN has picked up the file
(`https://app-site-association.cdn-apple.com/a/v1/openmapx.com`) and test a cold
and a warm link on a device with the signed build installed.

## The Android upload-key ceremony

1. Opt into **Play App Signing** when creating the app record. Google then holds
   the app-signing key; you hold only an upload key, and losing the upload key is
   recoverable through a support request. Not opting in makes key loss terminal.
2. Generate a dedicated upload key locally:

   ```bash
   keytool -genkeypair -v -keystore openmapx-upload.jks \
     -alias openmapx-upload -keyalg RSA -keysize 4096 -validity 10000
   ```

3. Store the keystore and its passwords in an encrypted password manager, and
   make **two** offline backups on separate media. Restore one of them and
   confirm it signs before considering the ceremony complete — an untested
   backup is not a backup.
4. Record the upload certificate fingerprint separately from Google's
   app-signing fingerprint, and label both. They are not interchangeable and the
   labels are the only thing preventing a mix-up.
5. Never copy the keystore into the repository, and never pass its password as a
   command-line argument, where it lands in shell history and process listings.
   The build script reads it from a mode-0600 properties file outside the tree.

## Apple signing recovery

1. Create the distribution certificate through the correct team. Keep the private
   key in the macOS Keychain.
2. Export one encrypted `.p12` recovery copy and store it offline. Test importing
   it on a second machine.
3. Prefer Xcode-managed signing for the first archive. Nothing is uploaded to a
   build service, because there is no build service.
4. Document how to revoke and regenerate: a revoked certificate invalidates every
   profile derived from it, and the recovery path is regeneration, not panic.

## Capabilities to enable, and to leave alone

Enable **Associated Domains** only. Leave push notifications, iCloud, Sign in
with Apple, App Groups, HealthKit, CarPlay, and everything else disabled. An
entitlement the app does not use is a question in review with no good answer, and
some of them change the privacy answers.

## What no script here does

No script accepts a store agreement, purchases a membership, uploads a build,
submits for review, or publishes a listing. Those are decisions with legal
weight and they belong to the account holder. The tooling's job is to make sure
that what gets uploaded is what was reviewed.
