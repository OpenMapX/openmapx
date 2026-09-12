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

Pull-request CI builds the docs image without publishing it. After a successful
CI run for the current `main` commit, `.github/workflows/docker.yml` builds changed
images as untagged candidates and reuses unchanged digests from the previous
complete release. A docs-only edit normally rebuilds only docs. All eight digests,
including reused ones, pass the current vulnerability scan. Weekly security
refreshes rebuild all images without Docker layer caching. Run-qualified tags
(`<commit>-<run-id>-<attempt>`) preserve each release; SHA tags are convenience
aliases that can move when the same commit is refreshed. After publishing the immutable
release manifest, it also advances and verifies `latest` compatibility aliases
for all eight images, including docs. These aliases move independently; they
cannot select an atomic multi-service release. CI publishes the complete set
through the final atomic deployment pointer
`ghcr.io/openmapx/release-manifest:latest`; resolving that manifest is
recommended because separate image tags cannot advance atomically. It serves
`docs.openmapx.org` as its own Compose project — completely separate from the
app stack — joining the existing Traefik network. From a repo checkout on the
host, extract the pinned docs image from the release manifest and use it for
both Compose commands:

```bash
docker pull ghcr.io/openmapx/release-manifest:latest
release_container=$(docker create ghcr.io/openmapx/release-manifest:latest true)
docker cp "$release_container:/release-manifest.json" /tmp/openmapx-release-manifest.json
docker rm "$release_container"

if ! OPENMAPX_DOCS_IMAGE="$(jq -er '.images.docs' /tmp/openmapx-release-manifest.json)"; then
  echo "The release manifest has no docs image" >&2
  exit 1
fi
if ! printf '%s\n' "$OPENMAPX_DOCS_IMAGE" | grep -Eq '^ghcr\.io/openmapx/docs@sha256:[0-9a-f]{64}$'; then
  echo "The release manifest contains an invalid docs image reference" >&2
  exit 1
fi
export OPENMAPX_DOCS_IMAGE
docker compose -f docs/deploy/docker-compose.yml -p openmapx-docs pull
docker compose -f docs/deploy/docker-compose.yml -p openmapx-docs up -d
```

Traefik issues the Let's Encrypt cert automatically (DNS already points at the
host). See `Dockerfile`, `nginx.conf`, and `deploy/docker-compose.yml`.

## Brand

Primary color is the Infima `--ifm-color-primary-*` scale in
`src/css/custom.css` (Material Green, `#43A047`). The site font is Google Sans
Flex (OFL). Logo and favicon live in `static/img/`.
