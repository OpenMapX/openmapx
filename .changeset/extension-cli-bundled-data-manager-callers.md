---
"@openmapx/extension-cli": patch
---

Refresh the extension CLI's bundled core inputs after the data-manager contracts
gained a `403` reply for a caller whose own token does not admit it to a route. The
extension scaffolding, validation and packaging command interfaces remain unchanged.
