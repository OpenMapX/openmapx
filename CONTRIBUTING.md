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

## Development setup

Requirements:

- Node 24+ (`.nvmrc` is authoritative)
- pnpm 11+
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

Every PR must pass the same checks CI runs:

```bash
pnpm lint           # Biome
pnpm check-types    # tsc across the workspace
pnpm test           # Vitest
```

Git hooks enforce a two-stage local gate:

- **pre-commit** — fast checks only: `pnpm lint`, `pnpm check-types`, and the
  legal/license/data-flow audits (`check-legal-tables`, `check-legal-updated`,
  `check-data-flows`, `check-license-metadata`). No Docker required; typically
  completes in under a minute.
- **pre-push** — full test suite (`pnpm test`). Requires Docker for the
  testcontainers-based suites; set `SKIP_TESTCONTAINERS=1` to bypass those
  when the daemon isn't running.

CI re-runs lint, types, and the full test suite on every push and PR, so the
safety net is always present.

### Testing

Tests run from a single root `vitest.config.ts`, split into two projects —
`node` (API, integrations, packages, services, scripts) and `web` (the Next.js
app and React-bound packages, in jsdom). There are no per-package Vitest configs
or `test` scripts; always run from the repo root:

```bash
pnpm test                            # whole suite
pnpm test --project web              # scope to one environment (web | node)
pnpm exec vitest run packages/core   # scope by path or test-name substring
pnpm test:coverage                   # V8 coverage report (written to coverage/)
```

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
- TypeScript everywhere. Avoid `any`; prefer `unknown` plus a narrowing
  type guard at the boundary.
- Don't add divider comments (`// ----` or `// ====`).
- Add a comment only when the *why* is non-obvious. Don't narrate the
  *what* — well-named identifiers cover that.

### Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org),
enforced by commitlint via Husky and by the `pr-title` GitHub Action.

Examples:

```text
feat(transit-hafas): add support for DB long-distance services
fix(routing): handle empty Valhalla isochrone response
docs(readme): clarify community integration install flow
```

### Changesets

User-facing changes to publishable packages must include a changeset, otherwise
CI fails:

```bash
pnpm exec changeset
```

The CI workflow runs `pnpm exec changeset status --since=origin/main` on
every PR and exits non-zero if a publishable package changed without one.
For PRs that touch a publishable package but intentionally don't need a
release entry — test-only edits, internal refactors, doc-only diffs —
add an empty changeset:

```bash
pnpm exec changeset --empty
```

App- and service-only changes (under `apps/`, `services/`, `integrations/`)
are skipped automatically because those packages are marked `private`.

## Pull request workflow

1. Fork and create a feature branch off `main`.
2. Open an issue first if the change is non-trivial — saves rework when
   scope or approach needs alignment.
3. Push your branch and open a PR. Fill out the PR template.
4. CI runs lint, types, tests, and the Docker build. Iterate until green.
5. A maintainer reviews. Squash-merge is the default; we keep the merged
   PR's title and summary as the squash commit message, so make both
   accurate.

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
