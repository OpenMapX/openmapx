---
"@openmapx/extension-cli": patch
---

Refresh the extension CLI's bundled core inputs following the update-system
replacement: unsigned control records without role keys, the configuration payload
travelling in the agent request, one configuration maintenance record in the
operations agent, the data-manager job kinds that now run as durable executions,
and the removal of the publisher cleanup flag from configuration outcomes. This
covers its bundled workspace dependency artifact; the extension scaffolding,
validation and packaging command interfaces remain unchanged. The administration
API and stack-management CLI are separate product surfaces.
