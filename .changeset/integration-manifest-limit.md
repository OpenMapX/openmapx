---
"@openmapx/extension-cli": patch
---

`openmapx-ext package` refuses a `manifest.json` larger than 128 KiB, the most the OpenMapX operations agent reads. An artifact with a larger manifest could not be installed.
