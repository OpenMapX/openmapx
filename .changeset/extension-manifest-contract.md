---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": minor
---

Fix the community manifest contract. `validateManifest` now takes `{ firstParty }` like `validateServiceManifest`. Community integration, service and extension manifests must declare `platform` and a semantic `version`, may only use `quality: "community"`, and refuse unknown top-level keys; `community-verified` is removed. Extension, service and integration ids use one grammar, `componentIdSchema` in `/identifiers` (a lowercase slug of at most 48 characters). Un-namespaced community capabilities and data types are errors: `collectCapabilityWarnings` and `ManifestValidationResult.warnings` are replaced by `capabilityNameErrors`. A new `/semver` entry point validates and orders semantic versions. Authoring schemas describe community manifests, carry the semantic-version pattern for `version`, and their `$id` is keyed on the protocol version (`…/extension-contracts/1.0/<name>.json`). The CLI scaffolds `"platform": "1.0"`, names the generated package `openmapx-integration-<id>`, defaults `bundle --platform` to its protocol and checks service manifests against it.
