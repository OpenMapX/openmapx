# @openmapx/extension-contracts

Portable manifest types, validators and compatibility rules for OpenMapX extension authors. OpenMapX and its authoring CLI use these same implementations.

For local qualification or a version not available on npm, build and install
the exact package tarball in a separate consumer project:

```sh
pnpm --filter @openmapx/extension-contracts pack --out /tmp/extension-contracts.tgz
# In a separate consumer project:
npm install /tmp/extension-contracts.tgz
```

The delivered package contains compiled ESM JavaScript, TypeScript declarations, structural JSON Schemas and its Apache-2.0 licence. It supports Node.js 24 and newer. It has no OpenMapX workspace, database, Docker, React or network-client dependency. Browser support has not been qualified.

## Supported entry points

| Import                                                                                                    | Purpose                                                                   |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `@openmapx/extension-contracts`                                                                           | Main manifest validators and types, artifact validation and compatibility |
| `/integration`                                                                                            | Integration manifests, source metadata and semantic validation            |
| `/service`                                                                                                | Service manifests and static provenance-aware community policy            |
| `/extension`                                                                                              | Component bundles, configuration, readiness and catalog shapes            |
| `/platform`                                                                                               | Extension protocol version and compatibility checks                       |
| `/artifact`                                                                                               | Declarative archive metadata and compatibility checks                     |
| `/contributors`, `/attribution`, `/licensing`                                                             | Captured contributor receipts and structured licence metadata             |
| `/identifiers`, `/media-hosts`, `/capabilities`                                                           | Source identifiers, media-host matching and capability names              |
| `/schemas`                                                                                                | Structural authoring schemas from `createAuthoringSchemas()`              |
| `/schemas/integration.json`, `/schemas/service.json`, `/schemas/extension.json`, `/schemas/artifact.json` | Packaged editor schemas                                                   |

`/licensing-schema` also exports the portable structural licensing schema.

Subpaths are supported interfaces. Files outside these exports are implementation details.

## Validate an extension

```ts
import { validateExtensionManifest } from "@openmapx/extension-contracts/extension";

const result = validateExtensionManifest({
  id: "example",
  name: "Example",
  version: "0.1.0",
  platform: "1.0",
  services: [
    {
      repo: "https://github.com/example/companion",
      ref: "v0.1.0",
      service: "example-service",
    },
  ],
  readiness: { requires: ["service:example-service"] },
});

if (!result.valid) throw new Error(result.errors.join("; "));
```

An integration artifact is declarative. Executable behavior belongs in its companion service. These contracts do not expose `IntegrationContext`, arbitrary host routes, Docker operations or custom same-origin presentation code. A service needs a supported host protocol or a reviewed built-in adapter to make its data available in OpenMapX.

## Validation and authority

The manifest validators check shape and applicable static semantics. `validateServiceManifest(input, { firstParty: false })` additionally applies the community sandbox policy. The host derives provenance from the actual installation location; data supplied by an extension cannot establish first-party authority. The CLI always validates services as community services.

Structural JSON Schemas help editors and non-TypeScript authors. Runtime validators additionally handle structured licensing, normalization, media-host rules, component references and community policy. Schema identifiers do not imply that those URLs host downloadable schemas. Use the files shipped in the package.

Neither schema validity nor an offline preflight proves that a host can download, install, start or trust a component. Installation also checks actual artifacts, source policy, privileges, configuration and runtime readiness.

## Version identities

The npm package version, OpenMapX product version, extension protocol version and artifact format version have separate meanings. Protocol `1.0` is not a statement that OpenMapX has reached a supported product `1.0` release.

A protocol requirement uses exactly `major.minor`: the host must have the same major and an equal or greater minor. Manifest validation checks the syntax; use `satisfiesPlatformVersion(required, current)` to check a particular host. The CLI composes both checks before validating or writing a bundle. Archive metadata has its own `schemaVersion`; compatible earlier protocol minors do not require byte-identical host versions.

Captured provenance distinguishes missing information from an explicit empty receipt. Preserve that distinction and all required notices through service caches and responses. The code licence does not grant rights to upstream datasets or images.

## Development

```sh
pnpm --filter @openmapx/extension-contracts check-types
pnpm --filter @openmapx/extension-contracts generate:schemas
pnpm --filter @openmapx/extension-contracts build
pnpm check-packed-packages
```

Regenerate schemas after changing manifest shapes or the package version; the build rejects stale schema content, including versioned identifiers.

The workspace resolves source entry points. `pnpm pack` applies `publishConfig.exports` to deliver JavaScript and declaration entry points from `dist`; release automation must publish that verified tarball. The clean-consumer gate checks the packed metadata and exercises JavaScript, strict TypeScript, CLI scaffolds and declarative artifacts outside the monorepo.
