# @openmapx/extension-cli

Standalone Apache-2.0 CLI for scaffolding, packaging, and validating OpenMapX integrations and services.

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

Creates `integrations/my-weather/` with `manifest.json`, `package.json`, and `strings/en.json`, with `__ID__` and `__DOMAIN__` tokens substituted. Executable behavior belongs in a companion service; community runtime entry points are rejected until a dedicated isolation boundary exists.

### scaffold service

Scaffold a `service.json` for a new community service:

```sh
openmapx-ext scaffold service my-data-service --out ./services/my-data-service
```

Creates `service.json` with the id substituted, ready to be filled in and registered with the OpenMapX service registry.

### validate

Validate an integration directory against the manifest schema:

```sh
openmapx-ext validate ./integrations/my-weather
```

Exits with a non-zero code and prints errors if the manifest is invalid.

### package

Package a declarative integration into a distributable `.tar.gz` artifact:

```sh
openmapx-ext package ./integrations/my-weather --out my-weather.tar.gz
```

Creates a declarative `.tar.gz` artifact suitable for installation via the OpenMapX admin panel. The packager rejects backend, POI-source, and same-origin frontend JavaScript.

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
