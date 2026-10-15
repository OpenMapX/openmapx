---
"@openmapx/integration-openconditions": patch
---

A road maintenance vehicle's id now carries where its position stood, so its
panel opens from the id alone: after an API restart, from a link, or from a
cached search answer. The provider no longer keeps an in-memory list of the
positions it has searched.
