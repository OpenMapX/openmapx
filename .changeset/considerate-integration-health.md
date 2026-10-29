---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": patch
---

Allow integration manifests to declare `healthCheckIntervalMs` for slower background health probes (minimum one minute). Explicit administrator probes remain immediate. Mangrove uses a static endpoint every 15 minutes instead of querying reviews every minute.
