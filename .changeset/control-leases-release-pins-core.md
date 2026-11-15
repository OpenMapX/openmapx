---
"@openmapx/extension-cli": patch
---

Refresh the extension CLI's bundled core inputs following the move of target leases
into the operations agent's store, the recoverable lock files and the release image
pins in the configuration generation. This covers its bundled workspace dependency
artifact; the extension scaffolding, validation and packaging command interfaces
remain unchanged. The administration API and stack-management CLI are separate
product surfaces.
