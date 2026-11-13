# Contributing to OpenMapX

You can contribute code, integrations, translations, tests, or documentation.
For usage questions and ideas, start in
[GitHub Discussions](https://github.com/OpenMapX/openmapx/discussions).
See [SUPPORT.md](SUPPORT.md) for help and reporting routes. All participation
is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

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
  improvements. See the [documentation guide](docs/docs/developer/documentation.md)
  for page structure, writing, and site checks.
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

Follow [Development setup](docs/docs/developer/development-setup.md) for the
pinned Node and pnpm versions, environment files, local database, and API/web
processes. The [self-hosting guide](docs/docs/install/getting-started.md) covers
running the managed Docker deployment; it is a separate workflow.

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
choose those when the changed behavior requires them. To confirm that a built
API image starts, run `scripts/ci/api-image-boot-check.sh <image>`, which CI also
runs on pull requests that rebuild the image. To follow the documented fresh
install against images built from your checkout, run
`scripts/ci/install-smoke.sh` on a Linux host with at least 8 GiB of memory for
Docker. It builds the five application images, starts the default stack and
removes the Compose project `openmapx` and the ignored files under `infra/docker`
afterwards, so it refuses to run beside an existing deployment. CI runs it on
main, nightly and on pull requests that touch the CLI, service rendering,
`services/`, `infra/docker`, the operations agent or a Dockerfile.

`pnpm verify:full` does not cover the repository scripts, the integration test
files or `packages/mobility-core`, which still have type errors.
`pnpm check-types:unenforced` reports their error counts without failing; when
you change those files, check that your change does not add errors.

### Running the full test suite on a Mac

Control-plane and filesystem-heavy tests (durable writes, fsync, lock files) are
much slower on macOS than on Linux and can time out there, especially when many
test files run in parallel. Such a timeout is not evidence of a defect. For a
reliable full-suite result on a Mac, run the tests in a Linux container that
matches CI. Use the Node version from `.nvmrc`, a non-root user and a copy of
the repository, and install `node_modules` inside the container; never reuse
the Mac's `node_modules`, which holds macOS native binaries.

```bash
docker run --rm --user node -v "$PWD":/src:ro "node:$(cat .nvmrc)-bookworm" bash -c '
  set -e
  umask 022
  mkdir ~/repo ~/bin && cd ~/repo
  tar -C /src --exclude=node_modules --exclude=.git --exclude=.turbo -cf - . | tar -xf -
  corepack enable --install-directory ~/bin
  export PATH=~/bin:$PATH
  pnpm install --frozen-lockfile
  npx vitest run --project node   # or a focused path, e.g. cd packages/core && npx vitest run src/build-artifacts
'
```

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

CI proposes checks from the complete immutable PR diff. The initial affected-job
rollout is in shadow mode: all jobs still run. After at least ten comparable
hosted PRs and dependency/asset review, approve `docs`, then proven `web`/`mobile`
classes in `scripts/ci-impact-rollout.json` on trusted main. PR edits to this file
cannot enable their own skips. Shared/backend/toolchain changes run the full gate.
Approved ordinary docs prose runs lint/policy, portable node contracts and the docs image; approved web
component or mobile runtime edits retain their relevant runtime, types, portable
contracts and builds without unrelated native recovery.
Unknown paths, incomplete diffs, symlinks and base retargets select full coverage.
Main pushes, daily reconciliation and manual CI run the full validation union.

The five logical database groups run across thirteen isolated runner partitions;
recovery scenarios are balanced without shortening real clocks or changing native
lifecycle assertions. Each group keeps one worker per runner. API/privacy and
ingestion use two file shards each; configuration and coordinator recovery use
four scenario partitions each; export/restore stays together. The final required
`lint / types / test` gate verifies every selected job and the complete disjoint
partition inventories. Linux deployment-user tests retain uid 1001/umask 002 with
two isolated single-worker file shards. Required failure/cancellation cannot pass.
Pull requests build and scan affected deployable images without publishing.
Repo-wide coverage remains weekly/manual and non-gating.

PR body/title edits refresh the required metadata/title check using only trusted
default-branch validation code. Every PR CI suite also executes the stable required
`lint / types / test` aggregate. It may reuse completed successful code evidence
for the same PR/head/base target, independently rechecked through GitHub's API.
Metadata gates are never code evidence. Failed, unfinished, missing or unbound
legacy evidence runs full validation; no skipped required check can hide it.
Candidate code never executes in the privileged metadata workflow. Code pushes and
base retargets still validate code; no protection or bypass changes are needed.
Main's obsolete validation can be superseded independently of atomic publication.

The duplicate-code audit reports new clone regions against each PR's base commit
in the workflow summary, with detailed reports attached as an artifact. PR reports
are advisory and do not block merging; the full weekly audit remains enabled.

Entur GraphQL operations and generated types are checked offline by
`pnpm check-entur-graphql`; native Geocoder v3 operations and Zod validators are
checked offline by `pnpm check-entur-geocoder`. Both are included in
`pnpm check:policy` and use committed snapshots without live schema downloads.
See the [GraphQL contract guide](packages/mobility-formats/entur/README.md) and
[Geocoder contract guide](docs/docs/developer/entur-geocoder.md) for regeneration
and deliberate, reviewed schema refreshes.

The lint job also audits production dependencies in the root and docs lockfiles.
New high or critical advisories block CI. A no-fix advisory can be acknowledged
temporarily in `scripts/production-audit-allowances.json`; the entry must match
its package, severity, installed version and workspace, and CI rejects it after
its expiry or as soon as a patched version is published.

### Testing

Give each contract a clear test owner. Prefer a real public entry point with
controlled external dependencies; a fake should not implement the behavior the
test claims to verify. Keep distinct security, persistence, lifecycle, wire and
platform risks, including static checks that enforce operational contracts.
Combine repeated scenarios and carry their unique assertions into the surviving
owner before deleting them. For repaired or transferred regression coverage,
confirm that a temporary production defect makes the intended assertion fail,
restore the source, and rerun the owner. Test size and coverage overlap alone do
not establish redundancy.

Tests run from a single root `vitest.config.ts`, split into two projects —
`node` (API, integrations, packages, services, scripts) and `web` (the Next.js
app and React-bound packages, in jsdom). There are no per-package Vitest configs
or `test` scripts; always run from the repo root. Privacy archive interoperability
tests require `python3` and `ruby` (including RubyGems) on `PATH`:

```bash
pnpm test                            # whole suite
pnpm test --project web              # scope to one environment (web | node)
pnpm exec vitest run packages/core   # scope by path or test-name substring
pnpm test:database api-privacy       # migrated disposable PostGIS + Docker required
pnpm test:database ingestion         # isolated ingestion fixtures + Docker required
pnpm test:database export-restore    # migrated disposable PostGIS + Docker required
pnpm test:database configuration-recovery # native configuration recovery
pnpm test:database coordinator-recovery   # native coordinator recovery
pnpm test:database crash-points      # process-level crash points (Linux, sudo)
pnpm test:database                   # full union, serially
pnpm test:database coordinator-recovery 1/4 # one complete scenario partition
pnpm build                           # production app/service/package outputs
pnpm check-packed-packages           # clean tarball consumer smoke test
pnpm test:coverage                   # V8 coverage report (written to coverage/)
```

The normal suite skips database tests. `test:database` enables them explicitly,
including restore replay for `export-restore` and the all-groups command. Each CI
group owns a separate runner and PostGIS service with the full production Drizzle
migrations. Suites stay serial within a group because some fixtures mutate shared
state. The launcher stops at the first failing test so native recovery failures
report promptly; successful groups run every selected test. Missing databases, schemas or Docker fail the run.

For a local run, use an owned disposable PostgreSQL 18 / PostGIS 3.6 database,
export its `DATABASE_URL`, and apply production migrations first. API/privacy,
export/restore and all-groups runs require that variable explicitly:

```bash
pnpm --filter @openmapx/api exec drizzle-kit migrate
```

The ingestion group runs the Transitous Python worker directly. In a Python
environment, install its production dependencies first:

```bash
python3 -m pip install --require-hashes -r services/motis/tools/transitous/requirements.txt
```

Run the export group with:

```bash
pnpm test:database export-restore
```

CI also runs the separate exact-image Dawarich export test in that group. Pull
the reviewed Dawarich image before running it:

```bash
image="freikin/dawarich@$(node --input-type=module -e 'const { DAWARICH_SUPPORTED_IMAGE_DIGEST } = await import("./packages/core/src/privacy/dawarich-contract.ts"); console.log(DAWARICH_SUPPORTED_IMAGE_DIGEST)')"
docker pull "$image"
OPENMAPX_RUN_DAWARICH_EXPORT_TESTS=1 pnpm exec vitest run --project node apps/ops-agent/src/dawarich-subject-export.integration.test.ts
```

### Crash-point suite

`apps/api/src/services/__tests__/crash-points/` pins the update and control
plane at boundaries that survive a rewrite of its internals. Each scenario
installs a fresh host in a temporary directory with the real CLI
(`compose release`, `compose render`, `compose up`), runs the API from source
and the operations agent, configuration helper and data-manager as their
runtime bundles, and injects faults only from outside: a fake Docker engine
behind a `docker` shim on `PATH`, HTTP proxies between the roles, and role
processes that are killed and restarted. Scenarios observe only HTTP answers,
job and agent operation states, CLI exit codes, the Docker trace and data
admission. They talk to the system only through `driver.ts`; a policy test
(`scripts/crash-point-imports.test.ts`) lets scenario files import only vitest,
the driver and the scenario wrapper, and refuses the suite any import of the
signed control layer, the agent or the data-manager. When the update system
changes, only the driver may change; scenario files stay as they are. Scenarios
that fail on today's code are listed, with the signature of their failure, in
`known-failures.json`; the suite's `README.md` gives the rules.

Each role runs in its own mount and PID namespace that reproduces its Compose
bind mounts and user, so the suite needs Linux, passwordless `sudo`, `unshare`
and `setpriv` (util-linux) and the Docker CLI with the Compose plugin (only
`docker compose config` is run for real). It needs no Docker daemon. Each
scenario creates and drops its own database and role on the server
`DATABASE_URL` names, whose user must be allowed to create roles and databases.
`OPENMAPX_RUN_CRASH_POINT_TESTS=1` turns a missing prerequisite into a failure;
CI sets it. The scenario with a full agent state filesystem also mounts a small
filesystem and runs only with `OPENMAPX_RUN_CRASH_DISK_TESTS=1`; without it,
that scenario is skipped. CI sets it too. `OPENMAPX_CRASH_DEBUG=1` prints the provisioning steps and
`OPENMAPX_CRASH_KEEP=1` keeps the host directory (role logs and the Docker
trace are in its `work/`) and the database after a run.

On macOS, or any machine without those prerequisites, run it in a disposable
privileged Linux container with its own dependency install, never sharing the
host's `node_modules`:

```bash
docker network create crash-net
docker run -d --rm --name crash-pg --network crash-net \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=openmapx_test \
  ghcr.io/baosystems/postgis:18-3.6@sha256:dd7515b7d8b8b8bac3516a9c3e12584df5890b0864c29295c1b934ecd1db81a7
docker run -d --init --privileged --name crash-dev --network crash-net node:24.22.2-bookworm sleep infinity
docker exec crash-dev sh -c 'apt-get update -qq && apt-get install -y -qq sudo curl \
  && arch=$(uname -m) \
  && curl -fsSL "https://download.docker.com/linux/static/stable/$arch/docker-29.0.0.tgz" | tar -xz -C /tmp \
  && cp /tmp/docker/docker /usr/local/bin/ \
  && mkdir -p /usr/local/lib/docker/cli-plugins \
  && curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
       "https://github.com/docker/compose/releases/download/v2.40.3/docker-compose-linux-$arch" \
  && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose'
docker exec crash-dev sh -c 'useradd -m runner && echo "runner ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/runner && mkdir /work && chown runner /work && corepack enable'
git ls-files -co --exclude-standard | grep -v '^node_modules/' | COPYFILE_DISABLE=1 tar -cf - -T - \
  | docker exec -i -u runner crash-dev tar -xf - -C /work
docker exec -u runner -w /work crash-dev pnpm install --frozen-lockfile
docker exec -u runner -w /work \
  -e DATABASE_URL=postgresql://postgres:postgres@crash-pg:5432/openmapx_test \
  -e OPENMAPX_RUN_CRASH_POINT_TESTS=1 -e OPENMAPX_RUN_CRASH_DISK_TESTS=1 \
  crash-dev pnpm test:database crash-points
docker rm -f crash-dev crash-pg && docker network rm crash-net
```

A tmpfs for `TMPDIR` inside the container (`mount -t tmpfs tmpfs /fast` as root,
then `-e TMPDIR=/fast`) makes runs on Docker Desktop considerably faster.

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
feat(transit-irail): add support for Belgian long-distance services
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

Do not add empty bookkeeping Changesets. CI validates new/updated notes, allowed packages and affected-package coverage. Shipped schemas, templates and documentation count as artifact inputs. Dependency-only changes are judged by each public package's resolved dependency tree: the `pnpm-lock.yaml` entries reachable from the package's own dependencies (build tools included) and, for the workspace packages it links, from their production dependencies and the devDependencies that provide their declared peers. This covers lockfile changes, and root or workspace `package.json` changes confined to `dependencies`, `devDependencies` and `optionalDependencies` when the manifest has its own lockfile importer. Such a change needs a note or explanation only for the packages whose tree changes; the check prints the result per package. This judgement relies on `pnpm check-declared-imports` (part of `pnpm check:policy`): every import in a public package's source, and in the workspace source the CLI bundles, must be declared in that workspace's own manifest, never only at the root or through hoisting, and a bundled workspace's runtime imports must be dependencies, optional dependencies or peers provided by a devDependency. A public package's own manifest and shipped manifests such as scaffold templates always count as artifact changes. Lockfile-wide settings such as overrides and patches, a lockfile the check cannot follow and other shared build inputs are treated conservatively; explain when they do not affect the qualified artifacts. A pending note from an earlier PR does not cover new work. These rules apply equally to humans and bots; a relevant dependency update needs a note or an accurate explanation before auto-merge.

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

Required CI retains this gate in the lint lane. The already-required
`Validate conventional commit title` job also validates the current release
classification on open, synchronization, reopen and body/title edits. It installs
only trusted default-branch dependencies with lifecycle scripts disabled, validates
immutable current head/base identities, and rejects metadata races. No PR code is
executed in this privileged metadata job. After the trusted gate reaches main,
body/title edits refresh metadata without restarting heavy CI; base retargets still
validate code. No required check context or live branch rule changes are needed.

A generated version PR uses `Package release: version`, or is recognized by an allowlisted manifest version change. It must exactly match a replay of the installed Changesets version command from its base: versions, changelogs, consumed notes and versioned schema IDs. Source/configuration/lockfile edits do not receive a release-PR exemption. A version-only batch cannot introduce important product declarations; commit those product fragments in the source contribution first. Regenerate the contracts schemas with `pnpm --filter @openmapx/extension-contracts generate:schemas` when their package version changes.

The historical mixed queue has been cleared without consuming its bumps. Private workspaces are excluded from Changesets versioning and tagging; `@openmapx/core` is private with development metadata `0.1.0`. The qualified public packages retain their existing `0.1.0` versions. Keep the default changelog and `format: false` for deterministic canonical replay without invoking a package-manager formatter. Package batches are prepared and published through the manual-only [independent package workflow](docs/docs/developer/package-releases.md). Empty queues are no-ops; qualification and protected OIDC publication are separate from version-PR preparation. This contribution gate does not publish packages or create a product release.

## Pull request workflow

1. Fork and create a feature branch off `main`.
2. Open an issue first if the change is non-trivial — saves rework when
   scope or approach needs alignment.
3. Push your branch and open a PR. Fill out the PR template.
4. PR CI checks code, tests, production builds, and affected Docker targets
   without publishing them. After merge, application release automation requires
   successful CI and publishes a coherent set of six application images plus
   its release manifest. Use a run-qualified tag or digest for rollback; SHA
   aliases can move after a security rebuild. See
   [Product releases](docs/docs/developer/product-releases.md) for publication,
   image reuse, security refreshes, and release selection. Documentation builds
   and publishes independently through `.github/workflows/docs.yml`; see
   [the docs deployment procedure](docs/README.md#deploy).
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
