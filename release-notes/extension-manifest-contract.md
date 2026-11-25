---
impacts: [breaking, operator-action]
---

## What changes

The extension contract is fixed for launch:

- Community integration, service and extension manifests must declare `"platform"` (the `major.minor` extension protocol, today `"1.0"`) and a semantic `version` such as `1.0.0`. They are strict at the top level: an unknown key, such as a misspelt `platfrom`, fails validation instead of being dropped. A host refuses a manifest whose protocol it does not support.
- `quality` is `built-in` or `community`. The self-declared `community-verified` label is removed from the manifest schemas, the admin badge, the service catalog filter and `openmapx services list --quality`. "Verified" remains a store tier the host derives from digest pins.
- Extension, service and integration ids are lowercase slugs of at most 48 characters, `^[a-z0-9]+(-[a-z0-9]+)*$` (no leading, trailing or double hyphen).
- In a community manifest, a capability or data type that is neither well-known nor namespaced as `<vendor>/<name>` is a validation error, not a warning. `timeline` and `llm-inference` join the well-known capabilities.
- The extension catalog and the revocation feed must carry `"schemaVersion": 1`; a host refuses a document with a missing or different format version, and the catalog must be an object, not a bare list of entries. A refused revocation feed keeps the last good denials and reports stale data.
- A `critical` revocation entry's `maxVersion` now limits the denial: the entry blocks that version and every earlier one by semantic-version order, and blocks every version when it has no `maxVersion`. `maxVersion` must be a semantic version. When several sources or entries name one extension, the widest denial applies, so a later catalog or the feed can never narrow an earlier advisory. The advisory is checked against the installed version as well: the admin catalog's `installedCritical` and the installed list's `critical` name an advisory that covers the running version, and the catalog entry is then `revoked` even when the offered version is fixed.
- The extension CLI scaffolds manifests with `"platform": "1.0"` and version `1.0.0`, names the generated package `openmapx-integration-<id>` instead of `@openmapx/integration-<id>`, and defaults `bundle --platform` to its protocol. The authoring JSON Schemas describe community manifests and their `$id` is `https://openmapx.org/schemas/extension-contracts/1.0/<name>.json`, keyed on the protocol instead of the package version.
- The unread `category` field is removed from the integration template and from every built-in integration manifest.
- A service's `configSchema` may list settings the operator must supply in its root `required` array. Applying a configuration that enables the service is refused, naming the service and each key, until every one has a value from the form or the environment or, for a secret, a stored credential. A service that is not enabled is not held to it, and a required key no longer makes the service's saved values invalid.
- A service manifest's `container` section is strict: a field the schema does not name, such as `containerName`, is refused instead of dropped.

## Who is affected

Operators who installed a community integration, service or extension, and the authors of such components or of catalog and revocation documents. Built-in components are not affected; every in-tree manifest validates.

After the upgrade, the API skips a community integration whose manifest fails the new rules and logs `Skipping integration <id>: manifest validation failed`. A community service repository whose manifest fails them is refused at inspection, installation and when the operations agent reads its store. A catalog or revocation feed without `"schemaVersion": 1` is refused; the store then reports a failed catalog acquisition or stale revocation data.

## Required action

Operators: after upgrading, check the API log and **Admin → Services** for refused community components. Update each one to a release that meets the new contract, or remove it. A custom catalog source must publish `"schemaVersion": 1` before it can be read again.

Extension authors: add `"platform": "1.0"` and a semantic `version` to every manifest, remove keys the schema does not name (including `category`), replace `community-verified` with `community`, namespace new capabilities and data types as `<vendor>/<name>`, and check ids against the new grammar. Validate with `openmapx-ext validate`, then publish the fixed release. Catalog and revocation maintainers: add `"schemaVersion": 1` and write `maxVersion` as a semantic version.
