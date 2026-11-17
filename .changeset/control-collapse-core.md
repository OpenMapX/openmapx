---
"@openmapx/extension-cli": patch
---

Refresh the extension CLI's bundled core inputs following the removal of signed
control records and role keys, the configuration payload travelling in the agent
request, and the removal of the publisher cleanup flag from configuration outcomes.
This covers its bundled workspace dependency artifact; the extension scaffolding,
validation and packaging command interfaces remain unchanged. The administration API
and stack-management CLI are separate product surfaces.
