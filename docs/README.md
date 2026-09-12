# OpenMapX documentation

The OpenMapX documentation site (https://docs.openmapx.org), built with
[Docusaurus](https://docusaurus.io/). Content lives in `docs/`; the site is
fully prerendered to static files.

This package is its **own** standalone pnpm workspace (`docs/pnpm-workspace.yaml`),
deliberately kept out of the monorepo's root workspace. It carries its own copy
of the root's supply-chain hardening. Run everything from this directory:

```bash
cd docs
pnpm install
pnpm start          # dev server with live reload
pnpm build          # static output in ./build
pnpm serve          # preview the production build
```

## Deploy

The dedicated `.github/workflows/docs.yml` workflow builds and type-checks docs
on docs changes. Trusted main builds publish an untagged candidate, run the
vulnerability audit and mandatory scan gate, then publish a run-qualified tag
(`<commit>-<run-id>-<attempt>`), a SHA convenience alias, and verified `docs:latest`.
Pull requests build without publishing. Weekly scheduled builds refresh OS packages
without layer caching; the repository variable `OPENMAPX_FORCE_DOCS_REBUILD=true`
also forces an uncached build on the next docs run. Manual runs are restricted to main.

Docs publication does not wait for application CI or application container builds.
The website runs as its own Compose project, joining the existing Traefik network.
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

For rollback, set `OPENMAPX_DOCS_IMAGE` to a previously published docs digest or
run-qualified tag. SHA aliases can move on a refresh of the same source commit.
Application release lockfiles contain only the seven application images: API, web,
data-manager, ops-agent, privacy-backup, transitous-runner, and transitous-tools.
Deploy the documentation website through its independent image channel above.

Traefik issues the Let's Encrypt cert automatically (DNS already points at the
host). See `Dockerfile`, `nginx.conf`, and `deploy/docker-compose.yml`.

## Brand

Primary color is the Infima `--ifm-color-primary-*` scale in
`src/css/custom.css` (Material Green, `#43A047`). The site font is Google Sans
Flex (OFL). Logo and favicon live in `static/img/`.
