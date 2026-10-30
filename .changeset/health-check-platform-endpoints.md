---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": patch
---

Accept `${endpoint:<id>}` in integration health-check URL templates and headers: the instance of a platform backend that the platform's own client queries (the self-hosted service, then the operator's URL, then the public default). `HEALTH_CHECK_ENDPOINT_IDS` lists the ids, currently `overpass`, and validation rejects any other. Rebuild the CLI against the updated portable contracts.
