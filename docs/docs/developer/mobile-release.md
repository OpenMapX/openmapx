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

Built-in reviewed integrations remain fully available, and the ordinary web app
and PWA keep community integrations exactly as before. Nothing here removes a
feature from the website.

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

## Local release commands

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
