---
"@openmapx/extension-contracts": patch
"@openmapx/extension-cli": patch
---

Check indexed reads in the extension contracts instead of assuming the element exists. Validated
licensing, platform versions, memory limits and media hosts behave as before; licence display
falls back to the declared expression if it cannot be parsed instead of throwing. Rebuild the
extension CLI against these contracts and the equally checked bundled core. The extension
scaffolding, validation and packaging command interfaces remain unchanged.
