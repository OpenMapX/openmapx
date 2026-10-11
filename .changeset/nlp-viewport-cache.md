---
"@openmapx/core": patch
---

Include submitted viewport bounds in the natural-language response cache identity, so explicitly resubmitting the same query after zooming searches the new area. Preserve the submitted query and viewport during parsing and suggestion settlement.
