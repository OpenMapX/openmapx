---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": patch
---

Add platform endpoints to the integration manifest contract. `PLATFORM_ENDPOINT_IDS` lists the backends a deployment can keep anywhere: `overpass`, `nominatim`, `photon`, `pelias`, `osrm`, `valhalla`, `motis` and `transitous`. `endpointConfigKeys` names the `configSchema` property that overrides one for an integration. Health checks may probe `${endpoint:<id>}`: the instance the integration queries (the self-hosted service, then the integration's URL setting, then the operator's URL, then the public default). Validation rejects unknown ids, undeclared properties, and an endpoint anywhere but as the whole URL prefix of `urlTemplate`, including in headers. Rebuild the CLI against the updated portable contracts.
