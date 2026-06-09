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

CI builds and pushes the image to `ghcr.io/openmapx/docs:latest` on
push to `main` (`.github/workflows/docker.yml`, path-filtered to `docs/**`). It
serves `docs.openmapx.org` as its own Compose project — completely separate from
the app stack — joining the existing Traefik network. From a repo checkout on
the host:

```bash
docker compose -f docs/deploy/docker-compose.yml -p openmapx-docs pull
docker compose -f docs/deploy/docker-compose.yml -p openmapx-docs up -d
```

Traefik issues the Let's Encrypt cert automatically (DNS already points at the
host). See `Dockerfile`, `nginx.conf`, and `deploy/docker-compose.yml`.

## Brand

Primary color is the Infima `--ifm-color-primary-*` scale in
`src/css/custom.css` (Material Green, `#43A047`). The site font is Google Sans
Flex (OFL). Logo and favicon live in `static/img/`.
