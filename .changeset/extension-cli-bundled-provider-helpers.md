---
"@openmapx/extension-cli": patch
---

Refresh the extension CLI's bundled core inputs after core gained one Retry-After parser,
one coordinate range check and one cache client, and dropped `ok` from error bodies. The
extension scaffolding, validation and packaging command interfaces remain unchanged.
