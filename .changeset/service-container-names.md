---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": minor
---

Service manifests no longer accept `container.containerName`. OpenMapX names every service's container `openmapx-<service-id>`, the same string as its network alias, so a manifest has no container name to choose. Remove the field from community service manifests; code that addresses a container by name uses `openmapx-<service-id>`.
