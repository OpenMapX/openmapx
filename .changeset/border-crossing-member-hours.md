---
"@openmapx/integration-openconditions": patch
---

A border crossing both agencies publish shows its opening hours whichever
agency's record OpenConditions keeps as the crossing's own. Only CBP states
hours, so a crossing whose CBSA record survives now takes them from its CBP
member, read from the area's per-source features; an excluded agency lends
none, and a failed read costs the hours, not the crossings.
