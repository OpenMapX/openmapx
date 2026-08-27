---
"@openmapx/core": patch
---

Bind verified extension trust to immutable content instead of source location.
Add a strict digest-pinned verified catalog entry schema, require unique
component ids and declared config/readiness targets in extension manifests, and
add `safeFetchText` so an untrusted body can be digest-verified before it is
parsed.
