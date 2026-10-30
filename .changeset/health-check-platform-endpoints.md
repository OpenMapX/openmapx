---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": patch
---

Accept `${endpoint:<id>}` in integration health-check URL templates and headers: the instance of a platform backend that the platform's own client queries (the self-hosted service, then the operator's URL, then the public default). `HEALTH_CHECK_ENDPOINT_IDS` lists the ids, currently `overpass`. Validation rejects any other id, and an endpoint anywhere but as the whole URL prefix of `urlTemplate`, including in headers. Rebuild the CLI against the updated portable contracts.
