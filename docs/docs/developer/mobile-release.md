---
title: Mobile release — local builds, store prerequisites, and the distribution boundary
description: How OpenMapX produces signed mobile release candidates locally, what the stores unavoidably require, and which decisions only the account holder can make.
sidebar_position: 10
---

# Mobile release

Everything that can be built locally is built locally. No cloud build service, no
EAS, no paid wrapper, no release SaaS. What remains hosted is the part that
cannot be anything else: the stores themselves.

## What the stores unavoidably require

These are facts about publishing, not choices the project made. They cost money
and require a real legal identity, and no amount of local tooling removes them.

**Apple.** An Apple Developer Program membership, currently **99 USD per year**.
Enrollment requires either an individual's real legal name (which becomes the
public seller name) or an organization with a D-U-N-S number. Distribution goes
through App Store Connect; TestFlight processing and review are Apple's.

**Google.** A Google Play developer account, currently a **one-time 25 USD**
registration fee. Personal accounts created recently must run a closed test with
**at least 12 testers continuously opted in for 14 days** before production
access is granted. Organization accounts may require a D-U-N-S number.

Neither identity may be fabricated. If the account holder will not accept these
costs and identity requirements, stop before creating any store record — a
reserved bundle identifier is effectively permanent.

### Before reserving anything

- Confirm ownership of the **OpenMapX** name for app-store purposes.
- Confirm the legal seller identity and public contact details.
- Confirm `org.openmapx.app` (both platforms) and the `openmapx` scheme.
- Confirm the fixed web origin `https://openmapx.com`.
- Accept the fees above.

Self-hosters do none of this. A self-hosted build uses its own application id,
its own signing identity, its own link associations, its own origin, and a
trademark-compliant name. It never reuses official signing material, and there is
no runtime server switcher — the origin is compiled in.

## The distribution boundary

A signed store binary must not be able to execute code a reviewer never saw.
This is not a preference; same-origin arbitrary JavaScript with access to page
globals is remote code execution, and it crosses the native bridge's trust
boundary.

So the installed shell:

- executes **no** administrator-installed or community frontend bundles;
- offers **no** microphone or camera, and the WebView denies both;
- gives the page **no** geolocation of its own;
- navigates only within the compiled origin, enforced both by the navigation
  allowlist and by WebKit App-Bound Domains;
- injects only a per-load channel nonce, never arbitrary script.

Built-in reviewed integrations remain fully available. Community runtime code is
also disabled in the ordinary web app and PWA; declarative community metadata and
safe static assets remain supported.

Enforced by:

```bash
pnpm -C apps/mobile exec tsx scripts/assert-no-community-runtime.mts
pnpm vitest run apps/web/src/providers/IntegrationProvider.test.tsx --project web
pnpm -C apps/mobile test -- App.test.tsx
```

The first reads the committed source and fails if the gate has moved, been
weakened, or started depending on a negotiated state instead of the synchronous
descriptor. It deliberately does not fail because the separately deployed PWA
bundle still contains the integration framework — that framework is a browser
feature and stays one.

## Licensing: the audit, and what it found

The intended end state is that the native shell in `apps/mobile/` carries
Apache-2.0 while the remotely served product stays AGPL-3.0-or-later, matching
the split the repository already uses for reusable libraries.

**That change has not been applied, because the audit found a blocker.**

`apps/mobile` links `@openmapx/i18n` — `shellCopy.ts` for the native overlay
strings, and `groundCue.ts` / `transitCue.ts` for navigation cue formatting.
`packages/i18n` is currently **AGPL-3.0-or-later**. An Apache-2.0 `apps/mobile`
that links it would be a combined work distributable only under the AGPL, so
labelling the directory Apache-2.0 would be inaccurate rather than merely
premature.

The other workspace dependencies are already compatible: `@openmapx/core` and
`@openmapx/mobility-core` are Apache-2.0.

### The one decision required

Relicensing `packages/i18n` to Apache-2.0 would clear this. It is our own code
and the CLA supports it, and a translation catalogue with ICU helpers is squarely
the "reusable library" category the repository already treats as permissive —
Apache-2.0 is one-directionally compatible with the AGPL, so the AGPL product may
continue to consume it unchanged.

But relicensing changes the terms third parties receive, which is the account
holder's decision and not an implementation detail. Until it is made:

- `apps/mobile/package.json` continues to declare `AGPL-3.0-or-later`;
- no `apps/mobile/LICENSE` is added;
- `LICENSING.md` describes the actual state rather than the intended one.

Do not resolve this by omitting notices or by quietly copying strings out of the
i18n package to dodge the dependency. Both would make the distributed binary's
licensing less true, not more.

## The release pipeline

Four commands, in order. None of them signs a store agreement, uploads a build,
or submits for review.

```bash
pnpm mobile:release:prepare    # every gate, fail-closed; builds nothing
pnpm mobile:release:ios        # xcodebuild archive + exportArchive
pnpm mobile:release:android    # gradle bundleRelease, signed with the upload key
pnpm mobile:release:verify     # inspect artifacts, write the provenance manifest
```

`apps/mobile/release/version.json` is the only source of the marketing version,
the iOS build number, the Android version code, and the supported protocol
range. Nothing derives a version from the clock or the branch — that choice is
what makes the useful check possible: comparing against the last `mobile-v*` tag
and refusing a rollback, a duplicate Android version code, or a raised protocol
minimum that would strand deployed web builds. A version derived from the current
time always looks newer, so it can never catch anything.

### Prerequisites

- **Disk**: roughly 15 GB free. An archive, an AAB, and a full Gradle build
  directory are each large, and running out mid-archive leaves a corrupt one.
- **JDK 17 or 21** on `JAVA_HOME` for Android. AGP's `JdkImageTransform` fails
  on newer JDKs with a message that points nowhere near the real cause;
  `prepare` checks this first so the failure is legible.
- **Xcode 26.4+** with the iOS 26 SDK.
- **Android signing properties** at `~/.openmapx/android-release.properties`,
  mode 0600:

  ```
  storeFile=/absolute/path/to/openmapx-upload.jks
  storePassword=…
  keyAlias=openmapx-upload
  keyPassword=…
  ```

  The build refuses a world-readable file, and never accepts these as
  command-line arguments — arguments land in shell history and in every process
  listing on the machine. Use `--unsigned` to rehearse without signing.

### What the manifest promises

`release-manifest.json` records the commit, the version, the dependency locks,
the normalized generated-native hash, the toolchains, hashes of the permission
and data-practice surfaces, public signing fingerprints, and a SHA-256 of each
artifact.

It does **not** promise bit-identical signed archives. Timestamps, signature
nonces and the certificate all differ between runs, so claiming reproducibility
would be false. What it promises is that the inputs are recorded — enough to
answer, six months later, what was in build 47 and whether an equivalent one can
be built again.

Artifacts, symbols and the manifest go to encrypted offline release storage.
None of them is committed; `dist/` is ignored.

### Failure recovery

`prepare` failing is the normal case and each message names the fix. The two
that look alarming and are not: a dirty worktree (commit or stash — a release
built from uncommitted changes cannot be reproduced), and a JDK version (set
`JAVA_HOME`). A failed archive is safe to retry after deleting the partial
`.xcarchive`; a failed Gradle build is safe to retry after `./gradlew clean`.

## Local check commands

```bash
# The boundary and configuration gates
pnpm mobile:verify              # expo-doctor under the project's tolerance policy
pnpm mobile:prebuild:check      # two clean CNG generations agree, and stay untracked
pnpm mobile:bundle:check        # the background bundle graph is headless-safe
pnpm -C apps/mobile exec tsx scripts/assert-no-community-runtime.mts

# The repository gates
pnpm test && pnpm check-types && pnpm lint && pnpm build
```

`ios/` and `android/` are generated build output. They are ignored, never
committed, and never hand-edited: a release fix changes `app.config.ts`, a config
plugin, a local Expo module, a lock snapshot, or a script, and then passes clean
prebuild again.

## What is never in the repository

Signing private keys, certificates carrying private material, provisioning
profiles, store API keys, app-specific passwords, reviewer credentials, and any
console export containing personal or legal data. Release artifacts, symbols,
and in-progress screenshots live in ignored `dist/mobile/` or in encrypted
offline storage. Public certificate fingerprints and finalised store artwork may
be committed.
