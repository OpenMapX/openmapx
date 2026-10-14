---
"web": patch
"@openmapx/i18n": patch
"@openmapx/integration-overlay-ambient-places": patch
---

Show published nearby places automatically as normal map content, without a Layers entry, legend or user toggle. Missing, disabled or stale publications leave the basemap alone, a failed refresh keeps only a fresh generation from the same API origin, and old `ov=ambient-places` links keep working without being written again.
