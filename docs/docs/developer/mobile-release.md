---
title: Mobile release
description: Local candidate preparation, signing inputs, version checks and release limits.
sidebar_position: 10
---

# Mobile release

Mobile artifacts are built locally with Xcode and Gradle. Store enrollment,
agreements, upload, review and publication are manual account-holder operations.
The current source is not ready for a navigation store submission: the installed
foreground bridge has no command dispatcher, signing identities are placeholders,
and physical beta evidence is absent from the repository.

## What the stores unavoidably require

The account holder needs an Apple Developer Program membership and App Store
Connect access for Apple distribution, and a Google Play developer account for
Play distribution. Verify current fees, identity checks, agreements and testing
eligibility in the relevant enrollment flow before spending money or reserving
identifiers. Repository files cannot establish whether an external account exists
or which requirements apply to it.

### Before reserving anything

- Confirm rights to use the OpenMapX name in the stores.
- Confirm the legal seller identity and public contact details.
- Confirm `org.openmapx.app`, the `openmapx` scheme and `https://openmapx.com`.
- Confirm enrollment, signing and beta-track access with the account holder.

A self-hosted distribution uses its own identifier, scheme, signing material,
associations, origin and trademark-compliant name. The origin is compiled in;
there is no runtime server selector.

## The distribution boundary

The installed WebView is restricted to the compiled origin. Camera, microphone
and WebView geolocation are disabled. Community frontend runtime code is disabled
in the app, ordinary web app and PWA. Declarative metadata and permitted static
assets remain supported; built-in integrations are part of the reviewed host.

Run these focused checks after a boundary change:

```bash
pnpm -C apps/mobile exec tsx scripts/assert-no-community-runtime.mts
pnpm exec vitest run --project web apps/web/src/providers/IntegrationProvider.test.tsx
pnpm -C apps/mobile test -- App.test.tsx
```

The source assertion checks the synchronous shell boundary. It does not inspect a
store-delivered binary or qualify provider behavior on a device.

## Licensing: the audit, and what it found

`apps/mobile/package.json` declares `AGPL-3.0-or-later`. The repository's licensing
decision keeps it under that licence while it links the AGPL `@openmapx/i18n`
package for shell strings and cue formatting. Shared `@openmapx/core` and
`@openmapx/mobility-core` code is Apache-2.0, but that does not remove the i18n
constraint.

### The one decision required

The intended Apache-2.0 shell requires a maintainer-approved licensing decision
for `packages/i18n`, with the necessary rights confirmed under the contribution
terms. Until then, retain the mobile AGPL declaration and existing notices. Do not
relabel the shell, omit notices or copy strings to conceal the dependency. See
[Licensing](https://github.com/OpenMapX/openmapx/blob/main/LICENSING.md).

## The release pipeline

Run from a dedicated, clean release checkout after resolving the blockers below.
These commands do not upload or publish:

```bash
export OPENMAPX_MOBILE_RELEASE=1
export OPENMAPX_APPLE_TEAM_ID=YOURTEAMID
pnpm mobile:release:prepare
pnpm mobile:release:ios
pnpm mobile:release:android
pnpm mobile:release:verify
```

Replace `YOURTEAMID` with the actual ten-character Apple Team ID. Keep the release
environment consistent when generating native projects and building artifacts.
`prepare` rejects the `.dev` identity produced without the release flag.

`prepare` validates inputs, then runs mobile tests, native tests, types, doctor,
clean prebuild, the background bundle check, permission/boundary/compliance/link
checks and root tests, types, lint and builds. It does not produce the final IPA
or AAB, but **it does run builds and regenerate native projects**. Its
`--skip-gates` option is a tooling rehearsal, not release qualification.

### Prerequisites

| Input           | Required source or location                                                |
| --------------- | -------------------------------------------------------------------------- |
| Node and pnpm   | `.nvmrc`, root `packageManager`, `release/toolchains.json`                 |
| iOS tooling     | Xcode 26.4 or newer; deployment target 16.4 in committed config            |
| Android tooling | JDK 17 or 21; set `JAVA_HOME` and ensure `java` on `PATH` agrees; SDK 36   |
| Apple signing   | Correct team, local Keychain identity and provisioning profiles            |
| Android signing | External properties file, default `~/.openmapx/android-release.properties` |
| Disk            | Space for two clean native generations, archives, bundles and symbols      |

The Android properties file must deny group/other access. Use mode `0600`:

```properties
storeFile=/absolute/path/to/openmapx-upload.jks
storePassword=REPLACE_LOCALLY
keyAlias=openmapx-upload
keyPassword=REPLACE_LOCALLY
```

Keep it outside the repository. `OPENMAPX_ANDROID_SIGNING_PROPERTIES` overrides
its path. The script copies it into the ignored generated Android directory;
protect and clean that copy as secret material. Never pass passwords as command
arguments. `pnpm mobile:release:android --unsigned` selects an APK rehearsal
instead of the signed AAB path; it is not a store candidate.

### Version and signing checks before building

`release/version.json` records marketing `1.0.0`, iOS build `1`, Android code `1`
and protocol v3 only. The release scripts compare it with the nearest reachable
`mobile-v*` tag to reject lower marketing versions, non-increasing build numbers
and a raised protocol minimum. Fetch and inspect the relevant release tags;
absence or an unreadable tag is treated by the script as no previous release.

The descriptor is **not wired into all native build inputs**: `app.config.ts`
hardcodes `version: "1.0.0"` and does not set iOS `buildNumber` or Android
`versionCode` from it. The committed Android build script copies signing
properties but does not itself configure Gradle to consume them. Confirm and fix
native version/signing configuration before release; a manifest copied from the
descriptor cannot establish the values or signing identity inside the binary.

### What the manifest promises

`verify-artifact.mts` inspects IPA/AAB/APK archive names and decompressed content
for forbidden markers, rejects embedded dSYM bundles, and writes
`dist/mobile/<marketingVersion>/release-manifest.json` only if its checks pass.
The manifest records the checkout, descriptor, declared toolchain versions,
available native lock hashes, generated-native hash, permission/data-practice
source hashes, public signing fields and artifact SHA-256 values.

This is a provenance record with bounded checks. It does not establish correct
binary version numbers, valid distribution signatures, all embedded permissions,
16 KiB native-library support or store acceptance. Some inputs can be absent or
null, and declared toolchain fields are not a full inventory of the compiler run.
Inspect the archive and signed package separately and retain that evidence.
Signed archives are not expected to be byte-identical across runs.

Keep artifacts, symbols and manifests in encrypted offline release storage;
`dist/` is ignored.

### Failure recovery

Run a failed gate directly for its full diagnostic. A dirty tracked worktree
needs review in the release checkout; preserve unrelated work. A JDK failure
needs a supported JDK on `JAVA_HOME` and `PATH`. Resolve the cause before retrying
an archive or Gradle build. Keep the rejected candidate's identity and results;
use new build numbers when candidate bytes change.

## Local check commands

Choose focused checks while editing; the complete release gate is separate:

```bash
pnpm -C apps/mobile test -- App.test.tsx compatibility.e2e.test.ts
pnpm -C apps/mobile run check-types
pnpm -C apps/mobile exec tsx scripts/assert-no-community-runtime.mts
pnpm mobile:qa:validate apps/mobile/qa/results/ios-simulator.json apps/mobile/qa/results/android-emulator.json
```

These do not establish physical-device acceptance. Follow the
[feasibility procedure](./mobile-feasibility.md),
[release matrix](https://github.com/OpenMapX/openmapx/blob/main/apps/mobile/qa/release/matrix.md)
and [store operations](./mobile-store-operations.md) before distribution.

Generated `ios/` and `android/` projects stay untracked. Release fixes belong in
committed config, plugins, local modules, lock snapshots or scripts.

## What is never in the repository

Do not commit private signing keys, private certificates, provisioning profiles,
keystores/passwords, store API keys, app-specific passwords, reviewer credentials
or console exports containing personal/legal data. Public signing fingerprints
and reviewed final artwork may be committed. Candidate screenshots, artifacts
and symbols belong in ignored release storage.
