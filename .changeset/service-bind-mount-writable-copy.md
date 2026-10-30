---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": patch
---

Accept `writableCopy` on a service bind mount: the `@infra:data/...` path of a writable copy of a file the container rewrites, which render seeds from the release's file. It requires a writable, non-optional mount of the service's own file; community services still cannot declare bind mounts. Rebuild the CLI against the updated portable contracts.
