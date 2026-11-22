---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": patch
---

Export `licenceLink`, the one canonical page for each SPDX licence, and use it
for the links that licence atoms carry, so equal credits from different sources
merge into one. Rebuild the extension CLI against the updated licensing
contracts.
