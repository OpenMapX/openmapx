---
title: Product releases
description: Prepare, rehearse and deliberately publish one coherent prerelease.
---

# Product releases

Named product releases are deliberate milestones, without a promised cadence. The first intended version is `v0.1.0-alpha.1`. This workflow is independent from npm packages, mobile store versions and documentation images. It currently targets `linux/amd64`; stable support is a later decision.

The seven-image manifest is the selection unit. A new name never makes reused images appear newly built: their original revisions, build times, provenance and SBOM stay attached to their exact digests.

## Prepare a candidate

1. Prepare a normal PR with `node scripts/prepare-product-release.mjs --version 0.1.0-alpha.1 [release-notes/selected-fragment.md ...]`. Review `scripts/product-release.json` and the matching page under `docs/docs/releases/`. Curate ordinary changes from merged PRs; incorporate and remove only fragments included in that release. The helper only edits local metadata and notes; it creates no commit, PR or release. Existing notes are edited deliberately rather than overwritten.
2. Merge the reviewed preparation PR and wait for its complete main CI run, including the coherent Docker producer. A superseded or skipped producer is ineligible. If no eligible complete image set exists, prepare a new reviewed source/run; there is no old-commit build bypass.
3. Dispatch **Prepare or publish a named product prerelease** on **main**, operation `prepare`, with that successful `source_run_id`. It reads the selected source's preparation record and notes as data. It runs trusted orchestration code from the main workflow ref. Main may have advanced after the selected eligible producer finished.
4. Inspect the GitHub draft and its assets. The small candidate metadata container is built before rehearsal, using unchanged product digests. No final version or preview alias is moved. The draft retains candidate, manifest, Compose summary, privacy evidence, exact-source instructions, notes and SHA256SUMS beyond the short-lived Actions artifacts.

Each new producer identity is `<commit>-<run-id>-<attempt>`. A retry can reuse earlier successful build-plan, digest and privacy artifacts from the same source/run, but never overwrites the earlier canonical release identity. Existing historical identifiers remain readable. Preparation retries and inspection use the candidate's recorded attempt and immutable producer metadata digest, not the run's latest attempt or a moving registry tag.

A draft is not a published release. Its `target_commitish` is the exact producer source. Preparation rejects conflicting version content. A partial upload can be retried for identical bytes only. Changing the candidate requires a new bound rehearsal and approval; normally use another prerelease version.

## Rehearse and record evidence

This requires separately authorized owned staging. Select the frozen metadata digest, not a moving pointer. Exercise a clean installation and an upgrade from an actual declared origin. For alpha.1 that origin is the real **prebaseline** deployment, not an invented previous named release. Record service health, authentication, navigation, saved places, representative provider failure and credit paths, and privacy evidence. Record recovery only where actually tested; image rollback does not undo migrations. These scripts do not create backups.

Upload a real `readiness.json` asset to the draft. Its strict schema contains:

- `schemaVersion: 1`, the exact `candidateHash` and `candidateManifestDigest` from `candidate.json`.
- Actual `environment`, `platform: "linux/amd64"`, ISO `testedAt`, declared `upgradeOrigin`, and `limitations` array.
- `checks` entries `cleanInstall`, `authentication`, `navigation`, `savedPlaces`, `providerFailure`, `credits`, `serviceHealth`, `privacyEvidence`, `upgrade`. Each has `passed: true` and an HTTPS `evidence` link to actual results.
- `immutableReleases`: `enabled: true`, `repository`, the same `candidateHash`, maintainer `checkedBy`, ISO `checkedAt` and an HTTPS `evidence` link to the settings readback.

Before approving, the maintainer checks `gh api repos/OpenMapX/openmapx/immutable-releases` with their existing administration authority and records the actual enabled readback. Ordinary GITHUB_TOKEN cannot read this Administration endpoint; no new publishing token or invented YAML permission is used. Readiness JSON is a record, not independent proof: review the referenced evidence. No passing readiness file is generated automatically.

Use `gh release upload v0.1.0-alpha.1 readiness.json --repo OpenMapX/openmapx` after review. SHA256SUMS describes the fixed staged assets; readiness is separately included in the approval snapshot and published native attestation.

## Approve and publish

Dispatch operation `publish` on main with `version` and exact `candidate_hash`. The inspect job revalidates candidate source/run, frozen metadata, all draft assets and readiness, then shows their identities and approval hash. Review the draft and evidence before the **single named-release environment approval**. That environment requires Medformatik, allows self-review and admits only the main branch.

After approval, publication re-reads the same assets and rejects any paused-approval mutation. The approval snapshot binds the release ID, version, name, public notes body, exact target, prerelease flag and every asset. It is checked again after scanning and registry promotion, immediately before GitHub publication. Every exact image passes the current mandatory HIGH/CRITICAL fixable-vulnerability scan using trusted orchestration policy. It promotes existing images without application rebuilds, verifies all seven version aliases and the named metadata alias, verifies/creates the exact-source Git tag, then publishes the complete GitHub prerelease. Native immutable-release and per-asset attestations are verified before preview advances. GitHub's immutable policy protects published assets/tag; registry version aliases are separately protected by exact-content conflict checks. Other package-write workflows are not a repository-wide cryptographic barrier.

Preview advances last. Failures before that write leave discovery unchanged. If the registry acknowledgement or readback fails after the write, preview may already point at the fully published candidate; retry inspects and reconciles that exact selection. Retry identical content to finish missing work; do not delete/rewrite published artifacts. A published GitHub release with a failed preview update can resume without uploading or rebuilding. All eight immutable version aliases must still exist at the expected digests; a published retry never recreates or overwrites them. An older retry never downgrades a newer preview. Named runs serialize, but GitHub concurrency is not a FIFO queue and does not retain every pending run. Corrected image bytes need another version.

## When GitHub requires maintainer workflow authority

GitHub's [Create and Update release endpoints](https://docs.github.com/en/rest/releases/releases?apiVersion=latest) require Workflows write permission when the target's workflow files differ from the default branch. `GITHUB_TOKEN` cannot receive that permission. An existing exact-source tag is not a documented exemption. Eligible older candidates remain supported without rebuilding or changing their source.

Before a release mutation, automation compares the target and current default branch workflow blob paths and SHAs. An incomplete comparison fails closed. If they differ, the run returns `status: owner-action-required` with a concrete handoff in its JSON output and Actions summary. This is a successful staging/validation handoff, **not a published release**. It contains the repository, exact source, version, candidate hash, frozen metadata digest, current default revision and exact API request. Publishing also includes the draft ID, approval hash and complete approved public snapshot. No credentials are printed or stored.

Use your existing authenticated maintainer `gh` session. Review the bound candidate and evidence, save exactly the handoff's `request.body` JSON as `request.json`, and run the printed `command` (`gh api ... --method POST|PATCH --input request.json`). Do not substitute another SHA, draft or body. For preparation, the POST creates only the exact tagless draft; retry the same `prepare` operation to upload and verify its assets. Do not publish it from that preparation handoff.

For publication, the handoff is produced only after the protected owner approval, current scans, exact registry version aliases and final draft-snapshot check. Recheck the displayed draft and complete public snapshot against the approval hash immediately before the owner PATCH. That manual mutation is the owner's final publication approval using their existing authority; the script cannot enforce human approval outside Actions. The owner must not execute a stale or changed handoff. PATCH publishes the exact draft and creates its exact-source tag if absent. Preview remains unchanged. Retry the same publish operation, including the normal protected approval: automation requires the native immutable release, exact tag, full approved content, asset attestations and all eight existing registry aliases before advancing preview. If any differ, stop rather than repairing published artifacts. No new stored token or broader Actions permission is needed.

GitHub authorization errors remain errors. They are never treated as a missing draft or a reason to retry under another identity.

## Select updates

| Selection                         | Meaning                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `OPENMAPX_RELEASE=main`           | Automatic complete development builds; bootstrap default and current test-instance choice. |
| `OPENMAPX_RELEASE=preview`        | Most recent deliberately published named prerelease. Missing preview fails.                |
| `OPENMAPX_RELEASE=v0.1.0-alpha.1` | Exact named prerelease; content must match the version.                                    |
| `OPENMAPX_RELEASE=sha256:<64hex>` | Exact metadata image digest, including an authorized staged candidate.                     |
| `OPENMAPX_RELEASE=local`          | Explicit local workflow; existing overlays still apply until cleared.                      |

The optional trusted repository setting is `OPENMAPX_RELEASE_MANIFEST_REPOSITORY`, default `ghcr.io/openmapx/release-manifest`. No stable/latest channel or main fallback exists. After the first real publication, explicitly choose preview for named prereleases; installation never guesses whether it exists. See [configuration migration](../install/configuration.md#changing-release-selection).

Use `pnpm openmapx compose release --status` to inspect deliberate pins and `pnpm openmapx compose release` to reselect. Normal service commands preserve an existing coherent overlay. Admin check stores the candidate ID/digest; apply uses exactly that stored candidate even if a pointer later advances. A configuration change requires a new check. The agent refuses to replace its own running image/helper; update these from the host first using [Upgrading](../install/upgrading.md).

## Verification boundaries

Portable tests exercise selection, identity, failure recovery and publication state machines using synthetic registries/GitHub data. They do not establish live workflow dispatch, GHCR promotion, installation, upgrade, restore or native-device acceptance. The first real candidate and preview-to-preview cycle require those separate authorized gates. This implementation does not publish alpha.1 or change a running instance.

The design adopts staged artifact promotion from [Authentik](https://github.com/goauthentik/authentik/blob/0bf3eb26917c7fdbee26b48ea8cc0145f3bdc9d5/.github/workflows/release-publish.yml), protected deliberate publication from [Immich](https://github.com/immich-app/immich/blob/53618ff7496ee313d1cff7b3bcdf19c82b765cdf/.github/workflows/draft-release.yml), and release-specific migration guidance from [Nextcloud](https://docs.nextcloud.com/server/stable/admin_manual/maintenance/upgrade.html) and [Mastodon](https://docs.joinmastodon.org/admin/upgrading/). Their build order and maintenance machinery are not copied wholesale.
