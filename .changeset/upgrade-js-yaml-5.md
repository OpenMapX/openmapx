---
"@openmapx/core": patch
---

Upgrade js-yaml from 4.x to 5.2.x. js-yaml 5 is a dual CJS/ESM package that addresses the merge-key DoS (GHSA-h67p-54hq-rp68) structurally and ships its own TypeScript types (the separate `@types/js-yaml` dev dependency is dropped). The Docker compose renderer's output is functionally identical; only cosmetic scalar quoting differs in one edge case (a bare `-c` argument is no longer single-quoted, and parses back to the same string).
