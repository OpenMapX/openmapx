---
title: GDPR export release evidence
description: Non-personal release evidence and the fail-closed gate for the data-subject export workflow.
sidebar_position: 9
---

# GDPR export release evidence

This page is an evidence record for the technical data-subject access and
portability workflow. It is deliberately not a compliance certificate. The
deployment controller must complete and approve the human legal and security
review before enabling wording that describes the workflow as verified.

## Release identity and compatibility

The release pipeline must replace the values below with the exact source
revision and generated evidence version before recording an approval:

| Item | Required value |
| --- | --- |
| Evidence version | `gdpr-release-v1.<sha256>` derived from the review label, source fingerprint and deployment facts |
| Repository revision | the immutable release commit |
| Privacy migration range | `0020`–`0036` (receipt snapshots, assisted identity, email challenges and delivery leases included) |
| Catalogue version | the `version` field of every registration in `apps/api/src/privacy/catalogue.ts` |
| Managed Dawarich image | `freikin/dawarich:1.10.3` |
| Managed Dawarich application commit | `da551a0e32f67b4d8ac6d50132c26634d6ad29a4` |
| Managed Dawarich image digest | `sha256:d7457e7b27a9992f2fdd367fe22a515b1b44fc6e0cfb7a68f3c69c439c465a6b` |
| Managed Dawarich schema fingerprint | `cddd7f3971bf07ffdcc51909714d90c0d476644e414c68aa9613a601cf4bc8f1` |
| Backup manifest contract | format `2`, regular files, size and lowercase SHA-256 verified immediately before extraction |

An image, application commit, schema relation, collector contract, catalogue
copy, legal setting or archive schema change invalidates the previous evidence
and requires a new review. Only current format-2 backup manifests are accepted for restore and privacy
extraction; size-only manifests are unsupported.

## Automated evidence

Run these commands from the repository root on the exact release revision and
attach their machine-readable output to the release record:

```bash
pnpm check:policy
pnpm openapi:generate && pnpm check-openapi
pnpm check-types
pnpm lint
pnpm exec biome check . --max-diagnostics=1000 --reporter=summary
pnpm exec vitest run
git diff --check
```

The Docker gate is required whenever managed Dawarich or isolated
backup extraction is enabled. It must run against the exact pinned image and
exercise the populated-account fixture, foreign-row isolation, credential
sentinels, attachment validation, cancellation and deterministic archive
semantics. If the image or fixture is unavailable, the readiness result remains
false and the release record must say `unavailable` rather than infer success.
For the managed Dawarich fixture, run:

```bash
OPENMAPX_RUN_DAWARICH_EXPORT_TESTS=1 pnpm exec vitest run --project node --maxWorkers=1 apps/ops-agent/src/dawarich-subject-export.integration.test.ts
```

## Machine readiness

`GET /api/privacy/admin/readiness` is the authoritative operational gate. It
must be false when any of the following is missing, stale or mismatched:

- the export key and private, backup-excluded artifact storage;
- cleanup, SLA/escalation and notification health;
- every catalogue registration and required operator task;
- managed-service and backup collector compatibility;
- policy, OpenAPI and bilingual legal-copy checks;
- current, unexpired approvals scoped to this evidence version.

Readiness is not a substitute for the controller's Article 12/15/20 analysis,
processor instructions, rights-of-others balancing, off-host review or
jurisdiction-specific restrictions. It only prevents the application from
presenting an incomplete technical result as complete.

## Human approvals and unresolved work

Current human approvals must cover all three scopes: `legal-content`,
`dsar-process` and `security-review`. They require attributable reviewers who
are not recorded implementation owners. The reviews cover:

1. A legal/privacy reviewer records the scope, identity proportionality,
   deadlines and extensions, recipient information, portability decisions,
   backup and retention treatment, rights-of-others policy and any GDPR/BDSG
   restriction.
2. A security reviewer records the authentication assurance, role isolation,
   key management, archive parser, streaming, attachment, isolated-container,
   cancellation and telemetry review.

The implementer must not create an approval on a reviewer's behalf. Missing
or expired approvals, unresolved operator tasks, unknown off-host systems,
unsupported processors and unavailable backups are blocking findings. Record a
reasoned exception in the case workflow instead of changing the machine gate.

## Known boundaries

The workflow includes only data that the deployment controller or its instructed
processors can access. Independent controllers, anonymous public requests,
off-host backups, generic text logs and browser-only state are described as
boundaries or separate tasks. The browser supplement is generated locally and
is never uploaded. Cryptographic deletion protects expired export ciphertext;
it does not erase a copy held by an uncontrolled backup or external controller.

## Implementation review — 2026-09-04

The review started from `1fe0d410` on `main` with a clean working tree. Review
fixes are intentionally uncommitted. This record is technical evidence, not a
legal approval or a sign-off that all six implementation plans are complete.

The review corrected:

- Missing browser sign-in/return routes and premature deletion of the download
  reauthentication cookie; repeat completion is now safe, including concurrent
  retries. Representative delivery accepts its own bound channel.
- Untrusted request-body authentication assurance and raw `Date` SQL parameters
  that prevented lifecycle transitions and challenge completion in PostgreSQL.
- Retry exhaustion being treated as assembly approval, deferrals consuming the
  retry budget, stale collector results, and regeneration leaving no runnable
  tasks. Reviewed omissions now appear in the delivered processing information.
- Concurrent generation and publication failures leaving deliverable metadata
  or ciphertext behind. Withdrawal wins the final request-version check.
- Archive writer failure deadlocks, early supplement decryption, canceled
  download locks, non-atomic storage-key collision handling, and retained wrapped
  keys after successful physical deletion.
- Retention ignoring administrator database settings and closed case metadata
  never expiring. Case cleanup waits for physical artifact cleanup and preserves
  evidence while another request for the subject remains active.
- A broken PostgreSQL inventory query, missing disclosure FK classification,
  omitted labeled places in portable data, and old approvals surviving newer
  rejections or expired replacement reviews.

A dedicated PostgreSQL lifecycle regression suite is now part of
`pnpm test:database`. It exercises generation, regeneration, credential
sentinels, concurrent reauthentication completion, single-use delivery,
withdrawal during publication, retry deferral, and retention of case evidence.
The pinned Dawarich integration fixture also passed during this review.

At that checkpoint, the following design gaps remained **release blockers**, represented
as failing readiness checks. Human approvals and environment flags for policy
checks do not fill these gaps:

- Preservation rows are recorded, but source-specific TTL/deletion paths do not
  consume the preservation helpers. Receipt-time preservation of short-lived
  source data has not been demonstrated.
- Managed and backup collectors still retain complete source-member buffers.
  The pinned functional fixture does not prove bounded memory for a large
  controller-wide export.
- Assisted intake still requires an existing user ID. The privacy-admin UI does
  not yet implement the complete inaccessible/deleted-account, representative,
  and bilingual operator workflow specified in the design.

The follow-up review below records implementation and verification of these
capabilities; this earlier checkpoint is retained as historical evidence. Independent security and deployment-specific
legal approvals remain separate requirements.

Validation recorded during the review:

| Check | Result |
| --- | --- |
| Full Vitest suite | 1,392 files passed; 14,776 tests passed, 65 skipped |
| Database suite against isolated PostgreSQL/PostGIS | 10 files, 51 tests passed |
| Pinned Dawarich Docker fixture | Passed |
| Final archive writer/assembler regressions | 6 tests passed |
| Readiness regressions | 3 tests passed |
| Repository type checking | All 29 tasks passed; API types rechecked after final writer change |
| Lint and translations | Passed with existing repository warnings |
| Policy checks | Passed |
| OpenAPI validation | 363 operations, document up to date |
| `git diff --check` | Passed |

The isolated database container and its test volume were removed. No worktree,
staging, commit, or push was performed.

## Release-readiness follow-up — 2026-09-05

The follow-up remains on `main`, based on
`1fe0d41066fa0a83572216f16078f0d658f313a0`, with all implementation changes
uncommitted. A source fingerprint identifies the reviewed bytes; the base
revision alone does not identify these changes. No deployment approval has been
entered by the implementing agents.

The work adds encrypted receipt-time projections of short-lived authentication
and offline controls, protected exact-locator matching for retained cases,
assisted email/account identity proof and representative authority review, and
delivery accounting only after the HTTP response finishes successfully.
Source capture failures produce explicit case tasks, including database errors
isolated with per-source savepoints. Active access cases retain their scoped
source material through account erasure; terminal and expired material is
physically cleaned before wrapped keys and metadata are removed.

Primary database projections use cursors inside a repeatable-read transaction
and write bounded encrypted replay streams. Managed and historical source
parsers also spool encrypted streams. The PostgreSQL memory fixture exercises
60,000 records with a 64 MiB V8 heap and checks process memory bounds.

Archive reports use the shared i18n registry and ICU translator, record language
fallbacks, and distinguish access from portability. They include configured
controller facts, source dates and outcomes, recipient information, retention,
rights and review information. Adding a language does not require an English/
German branch in archive assembly.

Release readiness binds approvals to implementation bytes, catalogue/contracts,
canonical copy and deployment settings. Missing or superseded approvals fail
closed. Independent legal, DSAR-process and security reviews and actual
deployment configuration remain external prerequisites.

The independent implementation review's four Important findings were fixed
and rechecked: source/build fingerprint coverage, recipient summaries honoring
reviewed omissions, report failures remaining retryable, and failed source
cleanup remaining visible and recoverable. No unresolved Critical or Important
finding was confirmed within that bounded review. This does not replace the
separate human approvals.

The production image includes the shared i18n package and its production
dependencies. A runtime smoke check verifies German translation resolution
inside the non-root, read-only image with networking disabled.

The dedicated key file uses a bounded versioned JSON ring. It requires exact `0400` permissions and the configured UID;
group/world-readable files are rejected. New writes use the active key version,
while retained versions can decrypt authorized old material. Readiness compares
the on-disk ring with the running ring and reports only version numbers.

The backup collector now lives under `services/ops-agent/privacy-backup` so it
does not masquerade as a runtime service. Its fixture restores actual OpenMapX
migrations through `0036` and pinned Dawarich 1.10.3, validates physical PostGIS
coordinates and paths, computes the full 25-relation column/FK fingerprint,
and rejects both column and ownership-graph drift. The exact retained tar is
then consumed by the controller-wide PostgreSQL fixture for two clean semantic
runs. All 30 applicable catalogue registrations have exactly one outcome.
The managed live collector also passes its separate pinned-image fixture.

The CI database job runs those Docker fixtures and passes the verified tar to
the serial database suite. Tests that intentionally run concurrent operations
continue to exercise those races; file-level serialization prevents global
retention fixtures from deleting another suite's test cases.

### Follow-up verification

| Check | Result |
| --- | --- |
| Full Vitest suite | 1,416 files passed; 14,897 tests passed; 98 skipped |
| Migrated PostgreSQL/PostGIS suite with real retained-backup input | 19 files, 84 tests passed |
| Controller-wide composite | Two clean semantic runs, every applicable registration represented |
| Pinned live Dawarich Docker fixture | Passed |
| Real-schema backup Docker fixture | Passed, including column/FK drift rejection and encrypted assembly |
| Versioned key ring, private-file and CLI compatibility tests | 70 focused tests passed |
| Repository type checking | All 29 tasks passed |
| Lint and translations | Passed; 0 translation errors, 227 warnings, 164 informational notices |
| Policy and OpenAPI | Passed; 368 OpenAPI operations |
| Fingerprint and runtime-package regression tests | 6 tests passed; six reviewed build-input mutations independently verified |
| API production Docker image | Passed with compilation offline; shared translator/core import as UID 1000 with networking disabled; embedded/source/evidence fingerprints match |
| Documentation build and final whitespace check | Passed |

The tested archive limits include a 2 GiB plaintext bound and 512 entries, with
512 MiB per encrypted replay member and 256 KiB per projected record. Receipt
sources have a separate 16 MiB bound. These are enforced ceilings, not a promise
that every request can fit in one archive; an oversized or unsupported source
requires an explicit case outcome and reviewed alternative handling.

The PostgreSQL cursor-to-archive memory fixture uses 60,000 records, a 64 MiB
V8 heap, and checks RSS below 320 MiB and external memory below 48 MiB. It
exercises source content larger than the configured heap. It is a synthetic
capacity test, not a production workload guarantee.

The source fingerprint for this uncommitted review is
`22964d649f1543078ddab4e2255122addf8af42c8abf52ce547399a2ab57fc69`.
Deployment evidence additionally binds controller, retention and source settings.
The machine-validation artifact is generated only after validators pass and
rejects a source change during validation.

Before deployment enablement, publish the reviewed collector image and record
its actual registry digest, mount matching machine-validation evidence, verify
runtime readiness and controller configuration, and obtain the independent
human approvals. No registry publication or deployment approval was performed
in this review.

All review changes remain uncommitted on `main`. No worktree, staging, commit,
push, production notification or deployment approval was performed. The
disposable verification database/container volume and the root-owned API build
tag were removed after verification.


## Restore-erasure alignment — 2026-09-05

A subsequent review of the preceding erasure implementation found that a valid
but incorrect journal key silently matched no erased accounts. It also found
that restore used older verification cleanup rules and did not reconcile the
new privacy artifacts. This follow-up supersedes the earlier restore-safety
assessment for those paths.

The v2 erasure journal binds its coverage timestamp to the key with a
domain-separated HMAC. Initialization, reads, appends, completion and compaction
validate the binding. Restore checks it before changing data and again after
isolating the API, including when no users exist. Only the current bound journal format is accepted. There is no legacy
migration or operator-recovery path. Compaction advances the authenticated coverage floor when
old requests are discarded, preventing a later retention increase from
re-enabling unsafe older backups.

Restore and live erasure share terminal-case and exact verification-identity
rules. Restored terminal artifacts are revoked and their attachments and
snapshots expired; wrapped keys remain pending monitored physical deletion.
Active cases retain their workflow state and minimized encrypted material,
while account-state metadata and request versions reflect account deletion.
The private export volume cannot be restored through backup archives.

Replay sends escaped COPY data through PostgreSQL standard input, excludes
subject identifiers from process arguments and suppresses potentially personal
replay diagnostics. It runs after all selected archives are restored and before
the API resumes. For a service with both database and filesystem backups, the
database is restarted and checked with bounded probes before replay. A replay
failure leaves the API stopped. The independent reviewer identified this
mixed-volume ordering issue; it was fixed and rechecked with no remaining
important finding in the bounded review.

The real restore fixture uses an isolated pinned PostGIS Compose project, all
production API migrations, actual pg_dump/restore, real encrypted storage and
an API sentinel. Six scenarios passed: erasure and cleanup parity; wrong-key
rejection with no users; identifiers containing COPY/SQL metacharacters; mixed
database/filesystem restore; rejection of an unsupported schema; and replay
failure preserving API isolation. Failed/missing/unsafe physical storage is
also exercised before successful cleanup. CI now runs this fixture in the
database job.

Verification for the follow-up:

| Check | Result |
| --- | --- |
| Migrated PostgreSQL suite | 19 files, 85 tests passed |
| Actual Docker/Compose restore fixture | 6 tests passed |
| Final affected unit/contract suites | 7 files, 121 tests passed |
| Changed-file formatting/lint and documentation build | Passed |
| Final CLI backup unit suite | 70 tests passed |
| Journal, Compose and API key-validation tests | 44 focused tests passed |
| Repository type checking | All 29 tasks passed; final CLI fixture types also passed |
| CI database wiring contract | 2 tests passed |
| Release validation | Translation, policy and OpenAPI validators passed |

The broad unit run passed 14,916 tests and reported one mixed-volume test
assertion from before the final readiness arguments were updated. The corrected
CLI suite passed all 70 tests, followed by the final seven-file run above.
An earlier resource-contention timeout in the unrelated trusted-configuration
suite passed on isolation (18 tests) and did not recur in the broader run with
four workers. No test implementation was weakened to bypass a runtime failure.

The new source fingerprint is
`6d1227dec7d071325a0e706c06b66007869fa64b15eb8a7b66355ba4910d3ea9`.
Matching machine evidence was regenerated. Earlier implementation approvals
and evidence must not be reused for these changed source bytes. Human review
and deployment prerequisites remain as documented above.

These follow-up changes are uncommitted on top of `2f4078d5` on `main`.
No production data, production journal, deployment approval or remote Git
reference was changed.

The disposable verification database and every fixture Compose container and
volume were removed after testing. Existing user containers were untouched.


## Current formats only — 2026-09-05

The operator confirmed that no OpenMapX instances have been deployed. The
feature therefore has no backward-compatibility or migration workflow for
pre-release data. Journal versions other than the current bound format use
ordinary validation errors; the special recovery branch and runbook were
removed. Managed export-key files always contain the bounded JSON ring,
including initial provisioning. The explicit development environment-variable
key option remains a supported configuration mode.

Only format-2 backup manifests with digests and mode-specific metadata are
accepted by the CLI, operations agent and privacy review contracts. The
current-schema replay SQL no longer has optional-table compatibility branches.
An incomplete schema causes rollback and leaves the API stopped. Corrupt
inventory entries can still be reported as diagnostics; they cannot be used
for extraction or restore.

Final verification after removal:

| Check | Result |
| --- | --- |
| Affected journal, key, backup and contract unit suites | 8 files, 191 tests passed; 4 Linux-only tests skipped on macOS |
| Real Docker/PostgreSQL restore suite | 6 tests passed, including unsupported-schema rejection |
| Repository type checking | All 29 tasks passed |
| Release validation | Translation, policy and OpenAPI checks passed; 368 operations |

The current source fingerprint is
`cd0a7c4e850008885b2fe290e77eda54d125a480544bc136891f51caacae24ea`.
Matching validation evidence was regenerated. Earlier fingerprints in this
report describe previous review checkpoints and must not be used for this
source. These changes remain uncommitted on `main`; no deployed data was
converted or removed and nothing was pushed.

## Deployment setup — 2026-09-05

The setup follow-up is based on `0c315c63` on `main`. The earlier uncommitted
checkpoint descriptions above refer to their original review dates; the export
and erasure work was subsequently committed. This section records the new
setup changes separately.

Official release publication now carries validator-produced evidence from the
same gated checkout as the image builds, together with the immutable backup
collector reference. Release activation provisions the collector and publishes
content-addressed evidence before switching the Compose overlay. Retained
files preserve rollback references, and file-backed read-only mounts also work
with a read-only API root filesystem. CLI provisioning creates an empty private
backup inventory directory on a fresh host.

Full administrators use `/admin/privacy-setup` to configure operator details,
email delivery, retention and declared sources, inspect translated readiness
checks, and record attributable reviews through the existing approval endpoint.
Privacy administrators retain their casework permissions and receive guidance
to contact a full administrator for deployment settings. Operator facts saved
in the database feed public legal pages and export reports; environment
settings retain precedence.

The setup does not supply implementation-owner identities, assert that
operator-managed backups exclude artifacts, send test email automatically or
approve a release. Current independent reviews and runtime readiness remain
required before generation. No legacy format or migration path was added.

The independent review identified and resolved two UI issues: readiness refreshes
could reset unsaved settings, and entered review decisions could follow a new
evidence version. Drafts now reset only when effective server settings change;
review fields and submission intent clear when evidence changes. The reviewer
reran the focused regressions and found no remaining blocker in that recheck.

Verification for this setup checkpoint:

| Check | Result |
| --- | --- |
| Final full Vitest run | 1,424 files and 14,975 tests passed; 24 files and 106 tests skipped |
| Documentation build and final whitespace check | Passed |
| Combined backend/settings/release integration checks | 142 tests passed; 4 platform-specific tests skipped |
| Final release publication, rollback and provisioning checks | 85 tests passed; 4 platform-specific tests skipped |
| Privacy API regressions | 179 tests passed; 37 database/fixture-dependent tests skipped |
| Final UI slice and static URL guard | 26 tests passed |
| Independent UI finding recheck | 14 tests passed |
| Repository type checking | All 29 tasks passed |
| Changed-file Biome | Passed; one existing informational template-style diagnostic |
| Release validation | Passed: 0 translation errors, policy checks and 368-operation OpenAPI document |
| Production API image | Built successfully; embedded fingerprint matches current source and generated evidence |
| Runtime smoke checks | Non-root, read-only evidence mount and root filesystem; shared German translator resolves without fallback |

The source fingerprint is
`ae0a17675ab6af4f04f5a6acb2551662011e3e8dee1e2a02852e831a9db2a7ae`.
It supersedes earlier fingerprints in this report for the current source.
The first broad test run found only the static URL guard's missing entry for
the new fixed internal readiness links. That narrowly documented guard entry
was added and the guard plus the UI slice passed; no production source was
changed to satisfy the guard.

The disposable runtime probe containers and API build tag were removed.
Existing user containers were untouched. These changes are uncommitted on
`main`; no release was published, approval recorded, email sent or Git change
pushed.

### Commit-time legal date update

The staged legal-copy guard required advancing the privacy and terms dates in
both languages to September 5, 2026. This date-only follow-up supersedes the
setup checkpoint source fingerprint above with `26b888904ef78962d8ab1e8fe5b4c5270ee395d456c749ca7fe0bd9f4f142965`.
Machine-validation evidence was regenerated for these final bytes. The full
suite and production-image checks above describe the preceding setup checkpoint;
the commit hooks additionally validate the final legal dates and source.
