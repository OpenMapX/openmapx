---
title: Independent package releases
---

OpenMapX packages use deliberate Changesets batches, independently of product
versions, Docker images and preview. Only `@openmapx/extension-contracts` and
`@openmapx/extension-cli` in `scripts/public-packages.json` are qualified. Their
initial declared versions remain `0.1.0` until an explicitly prepared batch.
Private workspaces are never published or tagged.

## Prepare and review a batch

1. Add consumer-focused Changesets in source PRs. Merge those PRs with normal CI.
2. On **main**, manually run **Independent qualified package release**
   (`.github/workflows/package-release.yml`) with operation **version**. No other
   inputs are needed. An empty queue is a no-op. All pending qualified notes and
   required dependent releases are processed by installed Changesets **3.0.3**.
3. Review the resulting `changeset-release/main` PR: versions, changelogs,
   consumed notes and versioned schema IDs must exactly match canonical replay.
   The version action does not update the lockfile. Source, config or lockfile
   additions fail the existing required CI gate; there is no author exemption.
4. The PR is assigned to Medformatik and labeled `ci`. A maintainer must use
   GitHub's **approve and run workflows** control for the bot-created PR. The
   workflow creates/updates the PR; it has no approval or merge step. Required CI
   must pass before the maintainer merges. Merging never publishes packages.

Local generation uses `node scripts/version-public-packages.mjs` in a clean
worktree; `--check` validates the queue without consuming it. Automatic formatting
is disabled in Changesets so generation does not invoke a package-manager
formatter. The canonical CI gate uses the installed CLI and trusted replay code,
never a version script supplied by the candidate PR.

The repository setting allowing Actions to create and approve pull requests is
needed for the standard version action. Default workflow permissions remain
read-only; only the manual version job receives contents/PR write. GitHub combines
creation and approval into one repository checkbox. This workflow does not use
its approval capability. Organization/repository activation is owned by the
maintainer and must be read back separately; source code does not enable it.

## Qualify initial candidates without publishing

Run operation **qualify** on main to build and pack both declared versions,
exercise their exact tarballs in an independent consumer, and download the
candidate artifact. This operation has no publishing environment or OIDC access.
It does not create notes, bump versions, publish, or create tags, even if npm has
no package records. Pending notes must be deliberately versioned first.

The artifact contains exact tarballs, the native Changesets packed plan and a
bounded `receipt.json`. The receipt records source SHA, workflow/run/attempt,
selected versions, consumer-only companions, tool versions, SHA512 npm integrity,
native plan SHA256 and candidate hash. It records the successful strict TypeScript
(NodeNext and Bundler) and CLI scaffold/package/bundle/rejection qualification.
The supplied-tarball checker never repacks, and hashes are checked before/after.

## One-time npm preparation and first publication

A public registry 404 does **not** prove scope ownership or the absence of private
history. An authorized npm owner must first establish account access, the
`@openmapx` scope, organization/package ownership and 2FA, and review any existing
private package/history. Ownership conflicts require investigation before any
mutation.

First publication is a **separate authorization**, using exact reviewed real
package tarballs/versions from qualification, never placeholders or synthetic
Changesets. This source workflow deliberately refuses ordinary publication when
the entire npm package record is absent. There is no first-publication switch or
stored-token fallback. Initial account setup, publication and acceptance have not
been executed by this implementation.

After the real package exists, configure its npm Trusted Publisher separately for:

- GitHub organization **OpenMapX**, repository **openmapx**;
- exact workflow filename **package-release.yml** (no directory prefix);
- GitHub environment **named-release**;
- permission to publish directly with **npm publish**. Current npm trust settings
  distinguish direct publication from staged publication. Explicitly allow direct
  publication; this design does not add npm staging or dist-tag management.

Configure publishing access to require 2FA and disallow traditional tokens. No
routine `NPM_TOKEN`, `NODE_AUTH_TOKEN`, PAT or npm account credential is stored in
the workflow. Check npm's current trust-configuration expiry and complete its
first validation within the documented window; recreate an expired configuration
through owner administration, never by introducing a token fallback.

Sources: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/),
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/),
[Changesets automation](https://changesets.dev/guide/automating).

## Approve and publish a merged batch

1. Wait for successful **CI** from a main push or schedule at the source you will
   dispatch. Select its numeric run ID, and the merged canonical version PR
   number. A PR/fork run, different workflow, wrong attempt, unfinished run or
   different SHA is rejected. Dispatch on **main** with operation **publish** and
   inputs `version_pr` and `source_run_id`. `github.sha` is the immutable source;
   an older successful CI run is not a way to publish an older source.
2. Qualification validates the actual PR base/head/merged data and canonical
   transformations for both the reviewed PR head and its squash merge. Its merge
   must be reachable from the source, current package versions must match the
   batch, and no pending qualified notes may remain. Unknown/private/outside-batch
   native plan entries fail, including tag-only entries. Future runtime dependency
   topology involving host/public workspace packages requires explicit closure
   support and currently fails with a diagnostic.
3. Review the run summary, selected packages, companion distinction, exact source,
   CI attempt, version PR, candidate hash and SHA512 integrities. Download the
   candidate artifact if needed. Approval occurs in the existing **named-release**
   environment, under its configured reviewer/main policy. Concurrency serializes
   package operations without cancelling approval/publication; GitHub's pending
   runs are not a durable FIFO queue.
4. The approved job downloads the immutable artifact **ID from that qualification
   job**, verifies its owning run/source/attempt and candidate hash, rechecks
   source/PR/CI and all tarball bytes, and publishes only the selected batch.
   Main can advance after dispatch or approval without changing the source or
   selected bytes. GitHub provenance retains the actual dispatch context; the
   workflow never overrides SHA/ref claims to imitate another source.
5. npm publishes the exact tarballs with scripts disabled, public access,
   provenance and ordinary **latest** npm dist-tags. These independent `0.x`
   package dist-tags have no relationship to product stable/main/preview. The job
   does not rebuild, repack, or run source lifecycle code. The pinned Node supplies
   npm; npm >=11.5.1 is required for OIDC, and this adapter requires **>=11.19.0**
   for its verified attestation-bundle audit output. No global local tool upgrade
   is performed. No dependency build cache is used in qualification/publication.
6. For each package, public registry bytes and integrity must match the candidate.
   An isolated exact-version install disables scripts; `npm audit signatures
--json --include-attestations` must cryptographically verify registry signatures
   and provenance. The **verified** SLSA bundle must name the exact subject digest,
   repository, workflow on main, dispatch event and source SHA. An attestation URL
   alone is insufficient. npm/registry/provenance failure remains a failed run.
7. Only after all selected packages verify, create package tags such as
   `@openmapx/extension-cli@0.1.1` at the bound source. Existing tags must resolve to
   that commit; collisions fail. There is no force update, broad follow-tags,
   product `v` tag, GitHub release, image publication or preview movement.

Only the final environment-protected job has `id-token: write`; its contents write
permission is for exact package refs. The qualification job has read access only.
Real GitHub dispatch/approval, OIDC exchange, npm trust, public provenance and tag
authority still require separately authorized live acceptance. Source tests and
local packing do not establish those platform properties.

## Partial failure and recovery

Registry authentication, network, 5xx and malformed responses fail closed; only an
absent exact version in an existing public package means unpublished. Propagation
polling is bounded. Publishing itself is never indiscriminately retried.

If a batch partially publishes, preserve npm history. Retry the same exact-source
batch: existing versions must match bytes and verified provenance before missing
versions can publish. They are never republished simply because a previous run
failed. If repacking on a new run produces different bytes, stop and investigate;
never overwrite/unpublish/delete a version or repair dist-tags to hide a conflict.
A complete workflow rerun requalifies artifacts and binds the new attempt; a
publish-job-only rerun cannot reuse a receipt from another attempt. Expired or
missing artifacts require requalification and a new approval, not a name/URL
fallback. Retention is 14 days.

A provenance failure after publication remains a failure; investigate the public
record before proceeding. A tag failure can be retried after npm verification. If
GitHub refuses a tag at the original source after main advances, the diagnostic
provides the exact tag/commit for a maintainer handoff. Do not retag latest main,
force a ref, or add a stored PAT. Missing direct npm trust permission is an owner
configuration issue, not a reason to bypass the protected workflow.
