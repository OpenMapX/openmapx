# Contributing to OpenMapX

Thanks for your interest in contributing. OpenMapX is a community-driven,
self-hostable mapping platform built entirely from open data and
open-source services. There's lots of surface area, which means lots of
ways to help.

Have a usage question or an idea to discuss? Please start in
[GitHub Discussions](https://github.com/OpenMapX/openmapx/discussions) rather
than the issue tracker — see [SUPPORT.md](SUPPORT.md). All participation is
covered by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Bug reports** — file an issue with reproduction steps and your environment
  (browser, Node version, which services / integrations you have enabled).
- **Feature requests** — open an issue describing the use case before opening
  a PR for anything non-trivial.
- **Integrations** — most user-visible behavior lives in `integrations/`.
  See the [Integration System](https://docs.openmapx.org/developer/integration-system/)
  and [Writing an integration](https://docs.openmapx.org/developer/writing-an-integration/)
  docs for the manifest format and the runtime contract.
- **Services** — backend daemons declared in `services/<slug>/service.json`.
  See the README's "Two plugin systems" section.
- **Documentation** — the README and the docs site (sources in `docs/`,
  published to [docs.openmapx.org](https://docs.openmapx.org)) both welcome
  improvements.
- **Translations** — strings live in `packages/i18n/`. Run
  `pnpm check-translations` to verify completeness.

## Issues and triage

Use the [issue forms](https://github.com/OpenMapX/openmapx/issues/new/choose)
to report a bug, request a feature or integration, or plan a task. The forms
assign the issue type automatically: **Bug** for defects, **Feature** for
feature and integration requests, and **Task** for maintenance, investigations,
and technical work. Labels describe a small set of actionable queues; they do
not duplicate issue types, priorities or estimates. See the
[contribution process](docs/docs/developer/contributing-process.md) for label meanings
and the triage lifecycle.

Write a descriptive issue title that names the problem or desired outcome,
such as "Station searches prefer unrelated POIs" or "Add support for a new
transit provider". Conventional Commits apply to commit messages and PR
titles; issues use their type and labels for classification.

Reporters can submit observations with an incomplete investigation. Include
what you know, supporting evidence, and open questions; you do not need to
prove the root cause or design a fix. Maintainers verify the report against
current code and complete the planning details during triage.

### Ready for implementation

Before scheduling implementation, maintainers check that an issue has:

- [ ] A verified problem or desired outcome, with reproduction evidence or
      a clear use case. Code claims reference the relevant files and revision;
      observations, hypotheses, and upstream behavior are distinguished.
- [ ] A bounded scope, explicit exclusions, and any unresolved decisions.
- [ ] Testable acceptance criteria and a verification approach. For an
      investigation, define the questions to answer and evidence to deliver.
- [ ] An appropriate issue type and any useful labels. A maintainer has considered
      **Priority** and **Effort** in the native issue fields; assign values when
      justified and leave uncertain estimates unset. Initial triage does not
      require speculative estimates.
- [ ] Dependencies and blockers recorded as linked issues where possible,
      or an explicit statement that none are known.

An open issue can remain in the backlog while these details are incomplete.
Keep `needs-triage` until the initial review is complete; removing it does
not by itself mean the issue is ready for implementation. Resolve or assign
blocking decisions before starting the work. Large efforts should be split
into linked tasks with independently verifiable outcomes.

## Development setup

Requirements:

- Node 24.21.0+ (`.nvmrc` is authoritative)
- pnpm 12
- Docker + Docker Compose if you want to run the self-hosted services

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
cp infra/docker/.env.example infra/docker/.env

pnpm dev          # apps/web + apps/api in dev mode (Turborepo)
```

The Docker stack (PostGIS, Martin, MOTIS, Pelias, etc.) is rendered on
demand from the manifests via the `openmapx` CLI (`pnpm openmapx compose
render` / `up`). See the [CLI reference](https://docs.openmapx.org/developer/cli-reference/)
and the [self-hosting guide](https://docs.openmapx.org/install/getting-started/).

## Quality bar

Before opening a PR, run checks appropriate to the change and report what you
verified. For code changes, run the focused tests and the affected package's
type check while iterating. Changes to shared code, dependencies, root config
or tooling need full local verification:

```bash
pnpm verify:full     # lint, workspace types, policy, OpenAPI, portable tests
```

Install both locked dependency sets first (`pnpm install --frozen-lockfile` and
`pnpm -C docs install --frozen-lockfile`); the policy probes check both.
`verify:full` waits up to 60 seconds for the machine's shared heavy-test lock,
reports the wait, and runs tests with half the workers. If another run holds
the lock longer, retry when it finishes. On systems without `flock` or `lockf`,
run it without other full suites running; the command prints a warning.
Database, mobile, production builds and native-device checks remain separate;
choose those when the changed behavior requires them.

Git hooks keep everyday commits and pushes inexpensive:

- **pre-commit** checks staged code with Biome and staged Markdown/YAML with
  Prettier, respecting generated-file exclusions. It reads the Git index and
  checks a temporary snapshot, so partially staged and unrelated working files
  stay intact. It reports required fixes without editing or staging files.
- **commit-msg** checks Conventional Commits with commitlint.
- There is no **pre-push** gate. A successful push does not establish that the
  change passes validation.

Whole-workspace types, translation completeness, policy, OpenAPI and portable
tests run through explicit commands and required CI. The hooks do not select
affected tests or run a hidden full-suite fallback. Documentation-only changes
normally need formatting and the affected documentation build; record any
checks left to CI in the PR.

CI runs lint, types, node/web/mobile tests, three isolated database groups, and
production builds as parallel jobs on every push and PR. Pull requests also
build each affected deployable Docker target without publishing it. These jobs are
aggregated under the required `lint / types / test` check; repo-wide coverage
runs on a weekly schedule (non-gating).

The lint job also audits production dependencies in the root and docs lockfiles.
New high or critical advisories block CI. A no-fix advisory can be acknowledged
temporarily in `scripts/production-audit-allowances.json`; the entry must match
its package, severity, installed version and workspace, and CI rejects it after
its expiry or as soon as a patched version is published.

### Testing

Tests run from a single root `vitest.config.ts`, split into two projects —
`node` (API, integrations, packages, services, scripts) and `web` (the Next.js
app and React-bound packages, in jsdom). There are no per-package Vitest configs
or `test` scripts; always run from the repo root:

```bash
pnpm test                            # whole suite
pnpm test --project web              # scope to one environment (web | node)
pnpm exec vitest run packages/core   # scope by path or test-name substring
pnpm test:database api-privacy       # migrated disposable PostGIS + Docker required
pnpm test:database ingestion         # isolated ingestion fixtures + Docker required
pnpm test:database export-restore    # also requires retained-backup fixture below
pnpm test:database                   # all three groups, serially
pnpm build                           # production app/service/package outputs
pnpm check-packed-packages           # clean tarball consumer smoke test
pnpm test:coverage                   # V8 coverage report (written to coverage/)
```

The normal suite skips database tests. `test:database` enables them explicitly,
including restore replay for `export-restore` and the all-groups command. Each CI
group owns a separate runner and PostGIS service with the full production Drizzle
migrations. Suites stay serial within a group because some fixtures mutate shared
state. Missing databases, schemas, Docker or required backup input fail the run.

For a local run, use an owned disposable PostgreSQL 18 / PostGIS 3.6 database,
export its `DATABASE_URL`, and apply production migrations first. API/privacy,
export/restore and all-groups runs require that variable explicitly:

```bash
pnpm --filter @openmapx/api exec drizzle-kit migrate
```

The export group and all-groups command also require the real retained-backup
fixture. Pull the reviewed Dawarich image and generate the archive before running:

```bash
image="freikin/dawarich@$(node --input-type=module -e 'const { DAWARICH_SUPPORTED_IMAGE_DIGEST } = await import("./packages/core/src/privacy/dawarich-contract.ts"); console.log(DAWARICH_SUPPORTED_IMAGE_DIGEST)')"
docker pull "$image"
export OPENMAPX_REAL_BACKUP_FIXTURE="$(mktemp -d)/openmapx-real-backup-result.tar"
node services/ops-agent/privacy-backup/test-fixture.mjs --output "$OPENMAPX_REAL_BACKUP_FIXTURE"
pnpm test:database export-restore
```

CI also runs the separate exact-image Dawarich export test in that group:

```bash
OPENMAPX_RUN_DAWARICH_EXPORT_TESTS=1 pnpm exec vitest run --project node apps/ops-agent/src/dawarich-subject-export.integration.test.ts
```

The group inventory lives in `scripts/database-test-groups.json`. The database CI
contract discovers opt-in suites and checks that every suite has exactly one owner
and that Vitest selects exactly those files. Register new database suites there;
do not add another command that silently falls outside required CI.

Conventions:

- **Co-locate** tests as `*.test.ts(x)` next to the code (or a sibling
  `__tests__/`). Web/React and `packages/core` hook tests get jsdom
  automatically; a node-only test that lives under `apps/web` can opt out with a
  `// @vitest-environment node` pragma.
- **Use the shared toolkits** rather than re-rolling mocks:
  `@openmapx/integration-framework/testing` (`createMockIntegrationContext`,
  `fakeHttpClient`, `loadFixture`), `apps/api/src/test` (`buildTestApp`,
  `createDbMock`, `mockRequireAuth`), and `apps/web/src/test` (`createFakeMap`,
  `renderHookWithQuery`, `mockNextIntl`).
- **Integration providers**: stub the HTTP layer (`vi.stubGlobal("fetch", …)`
  for global-fetch providers, or `fakeHttpClient` through a mock context) and
  assert the mapped output against a captured fixture. Pull pure mappers out and
  test them table-driven; prefer adding `export` to a helper over moving it.
- **Capability contracts** are enforced repo-wide by
  `apps/api/src/services/__tests__/provider-contract-conformance.test.ts`: a
  provider that declares a capability must implement its method.

### Code style

- Biome handles formatting and basic linting; configuration lives in
  `biome.json`. Don't reformat unrelated code in a feature PR.
- Biome cannot parse Markdown or YAML, so Prettier owns exactly those two
  extensions and nothing else (`.prettierrc.json`, `.prettierignore`). One tool
  per file type, so the two never format the same file. Generated documents are
  excluded, because their generators compare the committed bytes.
- TypeScript everywhere. Avoid `any`; prefer `unknown` plus a narrowing
  type guard at the boundary.
- Don't add divider comments (`// ----` or `// ====`).
- Add a comment only when the _why_ is non-obvious. Don't narrate the
  _what_ — well-named identifiers cover that.

### Commit messages

Commit messages and PR titles use [Conventional Commits](https://www.conventionalcommits.org),
enforced by commitlint via Husky and by the `pr-title` GitHub Action.

Examples:

```text
feat(transit-hafas): add support for DB long-distance services
fix(routing): handle empty Valhalla isochrone response
docs(readme): clarify community integration install flow
```

### Release information

| Change                                                                                      | Required release information                                   |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Qualified public package artifact or consumer contract                                      | Covering Changeset, or a specific non-release explanation      |
| Product breaking change, migration, significant security impact or required operator action | Committed product release-note fragment                        |
| Ordinary product feature or fix                                                             | Clear PR description, curated into product release notes later |
| Internal maintenance                                                                        | Usually neither                                                |

The explicit package boundary is [scripts/public-packages.json](scripts/public-packages.json): currently `@openmapx/extension-contracts` and `@openmapx/extension-cli`. Non-private metadata alone does not qualify a package for publication. The CLI bundles private workspace sources, so a change to one of those dependencies can affect its delivered artifact too.

This file sits beside the release-check scripts because it records OpenMapX's package qualification policy. It supplements the standard Changesets configuration in `.changeset/config.json`; it is not a separate versioning or publishing system.

For a public-package change, add a Changeset naming every affected qualified package and explain the consumer impact:

```bash
pnpm exec changeset
```

Do not select private application packages or broad core internals. Tests-only edits are recognized automatically unless those files are explicitly shipped, such as tests inside the CLI scaffold templates. Other edits that do not affect a release can use a specific explanation in the PR's **Release and upgrade impact** section:

```text
No package release: This changes only the test runner configuration; the published files and consumer behavior stay the same.
```

Do not add empty bookkeeping Changesets. CI validates new/updated notes, allowed packages and affected-package coverage. Shipped schemas, templates and documentation count as artifact inputs. Lockfile and shared build-input changes are treated conservatively; explain when they do not affect the qualified artifacts. A pending note from an earlier PR does not cover new work. These rules apply equally to humans and bots; a relevant dependency update needs a note or an accurate explanation before auto-merge.

For important product effects, add a fragment following [release-notes/README.md](release-notes/README.md) and declare its categories in the same PR section:

```text
Product impact: migration, operator-action
```

The allowed categories are `breaking`, `migration`, `security` and `operator-action`. Ordinary product work needs no marker or fragment. Database migration SQL changes require migration information automatically. Keep embargoed security details private under [SECURITY.md](SECURITY.md). Maintainers review classification, bump correctness, instructions and no-release explanations; CI cannot prove their semantic accuracy and does not introduce another required reviewer.

At product release preparation, maintainers curate a version-specific page in the existing documentation using the pending fragments and merged PRs. It should cover highlights, breaking changes, upgrade instructions and a categorized change list. See the [fragment guide](release-notes/README.md#preparing-product-release-notes) for the intended assembly process; this PR gate does not generate or publish those pages.

Check a committed candidate locally with the PR description saved to a file:

```bash
pnpm check-release-information --base origin/main --head HEAD --body-file /path/to/pr-description.md
```

Required CI runs this gate in the lint lane and reads the current PR body and target base, checking both immutable commit identities before evaluating the diff. This does not require rebasing the branch onto current main. Editing the PR body triggers CI again so its classification cannot remain stale; this currently reruns the full workflow. No required check name changes.

A generated version PR uses `Package release: version`, or is recognized by an allowlisted manifest version change. It must exactly match a replay of the installed Changesets version command from its base: versions, changelogs, consumed notes and versioned schema IDs. Source/configuration/lockfile edits do not receive a release-PR exemption. A version-only batch cannot introduce important product declarations; commit those product fragments in the source contribution first. Regenerate the contracts schemas with `pnpm --filter @openmapx/extension-contracts generate:schemas` when their package version changes.

The historical mixed queue has been cleared without consuming its bumps. Private workspaces are excluded from Changesets versioning and tagging; `@openmapx/core` is private with development metadata `0.1.0`. The qualified public packages retain their existing `0.1.0` versions. Keep the default changelog and `format: false` for deterministic canonical replay without invoking a package-manager formatter. Package release preparation and publishing automation remain separate work; the obsolete manual release workflow has been removed. This contribution gate does not publish packages or create a product release.

## Pull request workflow

1. Fork and create a feature branch off `main`.
2. Open an issue first if the change is non-trivial — saves rework when
   scope or approach needs alignment.
3. Push your branch and open a PR. Fill out the PR template.
4. PR CI runs lint, types, tests, production builds, and non-publishing Docker
   builds for the deployable targets affected by the PR. After a merge to
   `main`, a separate release workflow accepts only the current commit after successful CI,
   rebuilds images whose Docker build inputs changed since the last published
   release and reuses unchanged digests. All seven application digests pass the current
   vulnerability scan before publication. It publishes run-qualified release
   tags (`<commit>-<run-id>`) plus SHA convenience aliases and the
   complete release manifest with its CI run/attempt receipt, then advances and verifies all seven application `main`
   aliases. These development aliases move independently. The final
   `release-manifest:main` update is the pointer for atomic release selection.
   Weekly scheduled CI forces a no-cache security refresh through the same gates.
   Images at least seven days old also refresh on the next release. Set the
   repository variable `OPENMAPX_FORCE_IMAGE_REBUILD=true` to force the next run
   to rebuild all images; unset it afterwards to resume selective builds.
   SHA aliases can move on a refresh of the same commit; pin a run-qualified tag
   or digest for rollback. Each image retains its original source revision and
   build time in the manifest's `buildMetadata` when reused. Initial migration
   from a manifest without this metadata rebuilds all seven images.
   Manual dispatch cannot bypass the successful-CI requirement.
   Documentation publishes independently through `.github/workflows/docs.yml`,
   with its own build, type check and mandatory image scan. It never waits for
   application release jobs; see `docs/README.md` for its deployment procedure.
   The application release manifest is a **release lockfile**: it fixes the image
   set selected for an update. Container replacement still happens in steps.
5. A maintainer reviews. Squash-merge is the only merge method; the reviewed
   PR title and body become the squash commit message. Make both accurate
   and retain contributor attribution.

### Descriptions and visual evidence

Explain what changed and why, related work, verification, and release/upgrade
impact. Use a concrete problem and result; do not narrate the coding session.
Small PRs can combine prompts or omit empty sections. State relevant checks and
material limits accurately. Put long evidence ledgers in a collapsed section or
a durable public link. Use closing keywords only when the PR completes the issue.

Changes that visibly affect the OpenMapX application UI need screenshots prominently
in the PR description. Documentation-only changes do not require screenshots. Show labeled
before/after views for existing behavior, with comparable data and viewport; show
an after view with context for a new surface. Include affected states and relevant
mobile/desktop views. Capture the real result, inspect the images, and redact
personal data. A recording can supplement screenshots for interactions.

Upload images with the installed GitHub CLI, referencing their paths in the body
so they appear beside the explanation:

```bash
gh pr create --body-file /tmp/pr-body.md --attach ./before.png --attach ./after.png
# For an existing PR:
gh pr edit 123 --body-file /tmp/pr-body.md --attach ./after.png
```

After upload, inspect the rendered description and hosted images. Local paths
and expiring CI artifacts are not delivered evidence. If an attachment command
fails, check whether the PR or some assets already exist before retrying.

### AI assistance and accountability

AI assistance and coding agents working on authorized tasks are welcome. The
submitting contributor or maintainer owns the accuracy, understanding, verification,
evidence and review follow-up. The same checks and screenshot requirements apply.
Do not invent experience, results or claims. No AI declaration, footer or tool/model
inventory is required; answer honestly if asked and attribute quoted AI output
where relevant. Preserve meaningful existing provenance.

### Branch protection and review

Routine changes, including maintainer changes, reach `main` through a PR with
required checks. While the project has one active maintainer, no independent
approval is mandatory. Resolve review threads after fixing the finding,
explaining why it does not apply, or agreeing on a follow-up.

Branches do not have to be updated after every merge to `main`. Post-merge CI
still checks the combined result; repair a failing `main` before unrelated
merges continue. Administrator bypass is reserved for documented emergencies
through a PR. See the [protection runbook](docs/docs/developer/repository-governance.md)
for required checks and recovery.

## Licensing and the CLA

OpenMapX uses a two-license split: the product is AGPL-3.0-or-later and the
reusable libraries are Apache-2.0. See [LICENSING.md](LICENSING.md) for the full
breakdown.

Contributions are accepted under a Contributor License Agreement
([CLA.md](CLA.md)). You keep ownership of your contributions; the CLA grants the
maintainer the rights needed to keep the project sustainable, including offering
a commercial license alongside the AGPL.

You don't sign anything by hand. When you open your first pull request, an
automated assistant comments asking you to confirm you agree to the CLA by
replying:

```text
I have read the CLA Document and I hereby sign the CLA
```

Your agreement is recorded against your GitHub account and applies to future
contributions, so you only confirm once. If you contribute as part of your job,
make sure you're authorized to agree on your own or your employer's behalf.

## Reporting security issues

Please don't file public issues for security vulnerabilities. See
[SECURITY.md](SECURITY.md) for the private disclosure process.

## Code of Conduct

By participating you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
