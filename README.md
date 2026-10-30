<div align="center">

# OpenMapX

Self-hosted maps, search, directions, and public transit.

[![CI](https://github.com/OpenMapX/openmapx/actions/workflows/ci.yml/badge.svg)](https://github.com/OpenMapX/openmapx/actions/workflows/ci.yml)
[![CodeQL](https://github.com/OpenMapX/openmapx/actions/workflows/codeql.yml/badge.svg)](https://github.com/OpenMapX/openmapx/actions/workflows/codeql.yml)
[![Docker](https://github.com/OpenMapX/openmapx/actions/workflows/docker.yml/badge.svg)](https://github.com/OpenMapX/openmapx/actions/workflows/docker.yml)

[Documentation](https://docs.openmapx.org) · [Self-hosting](https://docs.openmapx.org/install/getting-started/) · [Contributing](CONTRIBUTING.md) · [Get help](SUPPORT.md)

</div>

OpenMapX is a map application you can run on your own infrastructure. Search for
places, plan ground routes and transit journeys, save lists, and explore map
layers. Optional integrations add street-level imagery, weather, reviews, and live
mobility data.

[Optional personal timeline](docs/docs/features/personal-timeline.md) connects
to an existing Dawarich account.

Features and geographic coverage depend on the services, integrations, and data
sources enabled on an instance. You can run local routing, geocoding, transit,
and tile engines, use hosted providers, or combine them. Hosted sources have
their own credentials, licences, usage limits, and privacy terms.

## Get started

- [Use the map](https://docs.openmapx.org/overview/using-openmapx/): find places,
  get directions, and choose the features you need.
- [Host an instance](https://docs.openmapx.org/install/getting-started/): prepare
  a server and configure the generated Docker Compose deployment.
- [Run a development environment](https://docs.openmapx.org/developer/development-setup/):
  work on the web app, API, or integrations.

Node and pnpm versions are pinned in `.nvmrc` and the root `package.json`.
Docker Engine with Compose v2 is required for local backend services. Follow the
setup guide for your use case before starting services or importing regional data.

## Two plugin systems

| Plugin      | Definition                        | Responsibility                                                                    |
| ----------- | --------------------------------- | --------------------------------------------------------------------------------- |
| Service     | `services/<slug>/service.json`    | A container: database, routing engine, geocoder, transit engine, or other backend |
| Integration | `integrations/<id>/manifest.json` | An application feature, provider, map overlay, or data-source adapter             |

The CLI renders the deployment from enabled service manifests. Integrations use
those services and external APIs through the integration host. The admin panel
manages configuration, service operations, capability bindings, accounts, jobs,
and installed community extensions.

Community extensions can contain declarative integrations, isolated service
containers, or both. See [How it works](https://docs.openmapx.org/overview/how-it-works/),
[the integration system](https://docs.openmapx.org/developer/integration-system/),
and [the external extension guide](https://docs.openmapx.org/developer/building-an-external-extension/)
for the contracts and trust boundaries.

## Operate a deployment

Run the CLI from the repository root:

```bash
pnpm openmapx --help
pnpm openmapx services list
pnpm openmapx check
```

Use the [CLI reference](https://docs.openmapx.org/developer/cli-reference/) for
commands and flags. Read [Upgrading](https://docs.openmapx.org/install/upgrading/)
and [Backup and restore](https://docs.openmapx.org/administration/backup-and-restore/)
before replacing a running deployment.

## Privacy and licensing

Ordinary synchronized account content is stored in the instance's PostgreSQL
database and is readable by the server and its operator. It is not end-to-end
encrypted. Provider requests normally pass through the API; browser capabilities,
external links, and configured providers have additional privacy boundaries.
Read the [user-data trust model](https://docs.openmapx.org/developer/user-data-trust-model/)
and the instance's privacy information before storing sensitive data.

The application is licensed under AGPL-3.0-or-later. Selected reusable packages
use Apache-2.0, and third-party code and data retain their own licences. See
[LICENSING.md](LICENSING.md) for the code licence map and commercial licensing.

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, tests, translations,
release information, and the pull request workflow. Documentation sources and
site commands are described in [docs/README.md](docs/README.md).

Use [GitHub Discussions](https://github.com/OpenMapX/openmapx/discussions) for
questions and the [issue forms](https://github.com/OpenMapX/openmapx/issues/new/choose)
for bugs and feature requests. Report security vulnerabilities through
[SECURITY.md](SECURITY.md). Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md);
contributions require the [CLA](CLA.md).
