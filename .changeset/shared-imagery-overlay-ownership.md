---
"@openmapx/core": patch
---

Allow enabled imagery providers to share one overlay registry entry when they
declare the same shared frontend layer, while still rejecting competing owners.
