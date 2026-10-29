# @openmapx/extension-cli

Standalone Apache-2.0 CLI for scaffolding, validating, packaging and bundling declarative OpenMapX extensions. It shares its portable contracts with the host through `@openmapx/extension-contracts`.

Node.js 24 or newer is required. For local qualification or an unpublished
version, run `pnpm --filter @openmapx/extension-cli pack --out /tmp/extension-cli.tgz`
and install that tarball in your authoring project. Use registry installation
only after confirming the desired version is published.

## Install

```sh
npm install -g @openmapx/extension-cli
# or run without installing
npx @openmapx/extension-cli --help
```

## Commands

### scaffold integration

Scaffold a new integration directory from the built-in template:

```sh
openmapx-ext scaffold integration my-weather --domain weather --out ./integrations
```

Creates `integrations/my-weather/` with `manifest.json`, `package.json`, localized strings and companion-response/attribution authoring examples. The generated package uses the public CLI as a development tool and has `validate` and `package` scripts; it has no private workspace dependencies. Run `npm install` after a matching CLI version is published, or install the candidate tarball with `npm install --save-dev /path/to/extension-cli.tgz` during local qualification. Then run `npm run validate`. Executable behavior belongs in a companion service; community runtime entry points are rejected until a dedicated isolation boundary exists.

The generated README explains lockfile setup and a repository-relative candidate tarball for use before publication. The included `.github/workflows/validate.yml` runs `npm ci --ignore-scripts`, validation and packaging, then retains the artifact for inspection without publishing or deploying it. It assumes the generated directory is the repository root; the README explains how to adapt nested projects. Commit the lockfile and any referenced candidate tarball before enabling it.

Use the [local development host walkthrough](https://docs.openmapx.org/developer/building-an-external-extension/#test-in-a-local-development-host) to install, reload, replace and remove the artifact. Companion-service lifecycle and displayed-data acceptance require a separate full-stack test.

### scaffold service

Scaffold a `service.json` for a new community service:

```sh
openmapx-ext scaffold service my-data-service --out ./services/my-data-service
```

Creates `service.json` with the id and owned-schema name substituted. Fill in
the service definition, validate it as a community service, then reference it
from an extension bundle. Scaffolding does not install or register the service
in a running host.

### validate

Preflight a declarative integration directory, including the packager’s community-code and referenced-asset checks:

```sh
openmapx-ext validate ./integrations/my-weather
```

Other authoring inputs have explicit kinds:

```sh
openmapx-ext validate ./service.json --kind service
openmapx-ext validate ./extension.json --kind extension
openmapx-ext validate ./contributors.json --kind contributors
```

Contributor input is an array of canonical captured receipts, including an explicit `[]` when no external credit is owed. Service validation always uses community provenance and rejects host-only privileges. Extension validation also checks compatibility with this CLI’s extension protocol version.

Invalid input exits non-zero with diagnostics. These checks do not prove download access, host configuration, runtime readiness or trust. The installing host still applies its own checks.

### package

Package a declarative integration into a distributable `.tar.gz` artifact:

```sh
openmapx-ext package ./integrations/my-weather --out my-weather.tar.gz
```

Creates a declarative `.tar.gz` artifact suitable for installation via the OpenMapX admin panel. The packager rejects backend and same-origin frontend JavaScript.

### bundle

Create an `extension.json` that pins integration artifacts and companion
service repositories into one installable extension:

```sh
openmapx-ext bundle \
  --id my-extension --name "My extension" --version 1.0.0 --platform 1.0 \
  --service "https://github.com/example/service,v1.0.0,my-service" \
  --integration "https://example.com/my-integration.tar.gz,<sha256>,my-integration" \
  --out extension.json
```

`--service` and `--integration` are repeatable. Their values are respectively
`repository,ref,serviceId` and `artifactUrl,sha256,integrationId`. Optional
bundle metadata includes `--description`, `--license`, and `--homepage`.

Integration artifacts are declarative. Put executable behavior and its types in
the companion service rather than depending on an in-process host SDK.

For bundles with configuration forwarding or readiness requirements, author the complete document and validate it before writing the output:

```sh
openmapx-ext bundle --input extension.source.json --out extension.json
openmapx-ext validate extension.json --kind extension
```

`--input` accepts the full shared extension manifest, including `config` and `readiness`. It cannot be combined with component or metadata flags. Invalid input leaves the output untouched.

The npm package version, extension version and minimum extension protocol are independent. Protocol requirements use `major.minor`, with the same major and a host minor at least as high as the requirement. Legacy range strings such as `>=1.0.0` must be written as `1.0` for this protocol contract.
