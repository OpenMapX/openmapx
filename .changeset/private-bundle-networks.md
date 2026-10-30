---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": patch
---

Accept `privateNetworks` and `platformNetwork` on a service manifest: a first-party bundle can join named `openmapx-private-<name>` networks and leave the shared `openmapx` network. Community services cannot declare either field, and neither combines with host networking. Rebuild the CLI against the updated portable contracts.
