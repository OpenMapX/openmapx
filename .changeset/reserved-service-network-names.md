---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": minor
---

Every service now answers to `openmapx-<service-id>` on the stack's Docker networks, and services reach each other only by that name, never by a bare service ID. Service manifest validation (`validateServiceManifest`, `checkManifestSandbox` and `openmapx-ext validate --kind service`) therefore rejects a service ID or a `container.networkAliases` entry that starts with `openmapx-`; the prefix is exported as `RESERVED_NETWORK_NAME_PREFIX`. Rename such an ID or alias, and point URLs at other services to their `openmapx-<service-id>` names, for example `http://openmapx-overpass:80`.
