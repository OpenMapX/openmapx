---
"@openmapx/core": patch
"@openmapx/ops-agent": patch
"@openmapx/data-manager": patch
---

Require a confirmed stopped or absent state for MOTIS stop operations. Dataset promotion must remain disabled until both ops-agent and data-manager support this contract; new clients reject legacy unconfirmed results. Bound pre-swap recovery independently of job cancellation and report unknown completion without changing data aliases.
