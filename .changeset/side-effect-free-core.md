---
"@openmapx/extension-cli": patch
---

Bundle only the core modules the extension CLI uses. The bundled core and mobility packages are
now marked free of import-time side effects, so unused core code no longer ships in the CLI. The
extension scaffolding, validation and packaging command interfaces remain unchanged.
