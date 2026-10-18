---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": minor
"@openmapx/core": patch
---

Add portable extension-author contracts and standalone validation, scaffolding and complete bundle input. Share host validators without exposing host runtime services, and qualify the built contracts and CLI tarballs in an independent consumer.

Enforce the documented `major.minor` extension protocol format and same-major compatibility. Replace legacy range requirements such as `>=1.0.0` with `1.0`. Packaging accepts installed authoring dependencies in source while excluding them from artifacts; installation still rejects dependency directories shipped in an archive.

This change does not publish packages or change the product release baseline.
