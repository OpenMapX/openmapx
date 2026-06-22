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

Creates `integrations/my-weather/` with `index.ts`, `manifest.json`, `package.json`, and `strings/en.json`, with `__ID__` and `__DOMAIN__` tokens substituted.

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

Build and package an integration into a distributable `.tar.gz` artifact:

```sh
openmapx-ext package ./integrations/my-weather --out my-weather.tar.gz
```

Bundles the backend (`index.ts`) and any declared frontend components, then creates a `.tar.gz` artifact suitable for installation via the OpenMapX admin panel.

## Authoring types

Integration authoring types (the `IntegrationContext` API, manifest schema, etc.) come from [`@openmapx/extension-sdk`](https://www.npmjs.com/package/@openmapx/extension-sdk).
