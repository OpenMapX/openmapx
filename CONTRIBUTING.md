# Contributing to OpenMapX

Thanks for your interest in contributing. OpenMapX is a community-driven,
self-hostable Google Maps alternative built entirely from open data and
open-source services. There's lots of surface area, which means lots of
ways to help.

## Ways to contribute

- **Bug reports** — file an issue with reproduction steps and your environment
  (browser, Node version, which services / integrations you have enabled).
- **Feature requests** — open an issue describing the use case before opening
  a PR for anything non-trivial.
- **Integrations** — most user-visible behavior lives in `integrations/`.
  See the [Integration System docs](docs/INTEGRATIONS.md) for the manifest
  format and the runtime contract.
- **Services** — backend daemons declared in `services/<slug>/service.json`.
  See the README's "Two plugin systems" section.
- **Documentation** — README, the docs in `docs/`, and the GitHub wiki all
  welcome improvements.
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
demand from the manifests. See `infra/docker/manage.sh` or the wiki's
self-hosting guide.

## Quality bar

Every PR must pass the same checks CI runs:

```bash
pnpm lint           # Biome
pnpm check-types    # tsc across the workspace
pnpm test           # Vitest
```

Git hooks enforce a two-stage local gate:

- **pre-commit** — fast checks only: `pnpm lint`, `pnpm check-types`, and the
  legal/data-flow audits (`check-legal-tables`, `check-legal-updated`,
  `check-data-flows`). No Docker required; typically completes in under a
  minute.
- **pre-push** — full test suite (`pnpm test`). Requires Docker for the
  testcontainers-based suites; set `SKIP_TESTCONTAINERS=1` to bypass those
  when the daemon isn't running.

CI re-runs lint, types, and the full test suite on every push and PR, so the
safety net is always present. If a check is slow, run only the affected
workspace (`pnpm -F @openmapx/core test`).

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

```
feat(transit-hafas): add support for DB long-distance services
fix(routing): handle empty Valhalla isochrone response
docs(readme): clarify community integration install flow
```

### Changesets

User-facing changes to publishable packages (currently just `@openmapx/core`
under `packages/core/`) must include a changeset, otherwise CI fails:

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

For convenience, install the
[Changeset Bot GitHub App](https://github.com/apps/changeset-bot) on the
repository. It posts a comment on each PR showing whether a changeset is
present and offers a one-click "Add changeset" link. The bot is
complementary to the CI gate — the App comments, the workflow blocks.

## Pull request workflow

1. Fork and create a feature branch off `main`.
2. Open an issue first if the change is non-trivial — saves rework when
   scope or approach needs alignment.
3. Push your branch and open a PR. Fill out the PR template.
4. CI runs lint, types, tests, and the Docker build. Iterate until green.
5. A maintainer reviews. Squash-merge is the default; we keep the merged
   PR's title and summary as the squash commit message, so make both
   accurate.

## Reporting security issues

Please don't file public issues for security vulnerabilities. See
[SECURITY.md](SECURITY.md) for the private disclosure process.

## Code of Conduct

By participating you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
