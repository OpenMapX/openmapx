---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": patch
---

Export bounded service image-reference validation and reserve platform resource
configuration names for trusted built-in services. Rebuild the extension CLI
against the updated shared installation and service contracts.

Keep newly created artifact and hardlink-consumer paths non-group-writable
on hosts using umask `002`.
