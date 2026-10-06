---
"@openmapx/core": minor
"@openmapx/api": minor
"web": minor
---

Add configurable OpenFreeMap hosted vector maps with a keyless automatic fallback, while always preferring enabled or explicitly configured self-hosted tiles. Expose a secret-free map configuration schema, connect environment and admin provider settings, preserve owned styles and offline credits, and allow admin-stored MapTiler keys in the asset proxy.

Preserve unchanged redacted admin credentials when saving settings, keep provider editing available when an invalid environment override is ignored, and resolve discovered local tile/glyph paths against the web origin independently of a separate API origin.
