---
"@openmapx/extension-cli": patch
---

Refresh the CLI's bundled shared HTTP contract machinery after extracting the
application-neutral operation binder. Extension administration operations and CLI
commands retain their existing behavior; saved-place application SDK generation
is a separate application surface.
