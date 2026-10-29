# OpenMapX documentation

The [OpenMapX documentation site](https://docs.openmapx.org) is built with
[Docusaurus](https://docusaurus.io/). Content lives in `docs/`; the site is
fully prerendered to static files.

This package is its **own** standalone pnpm workspace (`docs/pnpm-workspace.yaml`),
deliberately kept out of the monorepo's root workspace. It carries its own copy
of the root's supply-chain hardening. The commands below run from this directory:

```bash
cd docs
pnpm install --frozen-lockfile
pnpm start          # dev server with live reload
pnpm typecheck      # check TypeScript before building
pnpm build          # static output in ./build
pnpm serve          # preview the production build
```

## Edit and check content

Published articles live in `docs/`; navigation is defined in `sidebars.ts`. See
[Writing documentation](docs/developer/documentation.md) for page placement, prose,
links, and verification. Keep public page paths when reorganizing navigation.

`pnpm build` rejects broken internal links and heading anchors. Run `pnpm typecheck`
as well, then inspect the production build with `pnpm serve`. Check presentation
changes on narrow screens and in light and dark themes. Use the root workspace's
Prettier for changed Markdown files. The root Biome configuration excludes this
standalone workspace; preserve its existing TypeScript and CSS style.

## Deploy

Pull requests validate docs once through required CI's `build Docker (docs)` job,
without registry credentials or publication. The shared `docs/Dockerfile` runs
TypeScript checks before building the site.

The independent `.github/workflows/docs.yml` publisher uses the same Dockerfile
for trusted main builds. It publishes an untagged candidate, runs the
vulnerability audit and mandatory scan gate, then publishes a run-qualified tag
(`<commit>-<run-id>-<attempt>`), a SHA convenience alias, and verified `docs:latest`.
Weekly scheduled builds refresh OS packages
without layer caching; the repository variable `OPENMAPX_FORCE_DOCS_REBUILD=true`
also forces an uncached build on the next docs run. Manual runs are restricted to main.

The deployment commands below run from the repository root and require Docker
and `jq`.

Docs publication does not wait for application CI or application container builds.
The deployment example in `deploy/docker-compose.yml` is for the project's
documentation host: it uses `docs.openmapx.org`, the external `docker_openmapx`
network, and an existing Traefik proxy with Docker discovery, a `websecure`
entrypoint, and a `letsencrypt` certificate resolver. It does not create that
proxy or its network. Adapt those values for another host.

The application's bundled Traefik uses generated file configuration and does not
discover this separate container's Docker labels. Joining its network alone will
not publish the docs site; use a proxy configured for this deployment.

Resolve the docs channel once to an immutable digest for both deployment commands:

```bash
docker pull ghcr.io/openmapx/docs:latest || exit 1
if ! OPENMAPX_DOCS_IMAGE="$(docker image inspect ghcr.io/openmapx/docs:latest | jq -er '
  .[0].RepoDigests | map(select(test("^ghcr\\.io/openmapx/docs@sha256:[0-9a-f]{64}$"))) | .[0]
')"; then
  echo "The pulled docs image has no approved immutable reference" >&2
  exit 1
fi
export OPENMAPX_DOCS_IMAGE
docker compose -f docs/deploy/docker-compose.yml -p openmapx-docs pull || exit 1
docker compose -f docs/deploy/docker-compose.yml -p openmapx-docs up -d
```

For rollback, resolve a previously published docs image to its immutable digest
and set `OPENMAPX_DOCS_IMAGE` to that digest. SHA aliases can move on a refresh of the same source commit.
Application release lockfiles contain only the seven application images: API, web,
data-manager, ops-agent, privacy-backup, transitous-runner, and transitous-tools.
Deploy the documentation website through its independent image channel above.

Point the docs hostname's DNS at the proxy and configure its ACME challenge before
deployment. See `Dockerfile`, `nginx.conf`, and `deploy/docker-compose.yml`.

## Brand

Primary color is the Infima `--ifm-color-primary-*` scale in
`src/css/custom.css` (primary `#207E23` in light mode, `#71D674` in dark mode). The site font is Google Sans
Flex (OFL). Logo and favicon live in `static/img/`.
