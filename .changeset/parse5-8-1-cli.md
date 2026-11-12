---
"@openmapx/extension-cli": patch
---

Rebuild the extension CLI with parse5 8.1.0, which the bundled core inputs use. parse5 8.1.0 ends an attribute name when the whitespace before the next one is missing. The extension scaffolding, validation and packaging commands are unchanged.
