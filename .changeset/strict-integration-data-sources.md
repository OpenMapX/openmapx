---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": minor
---

Integration manifest validation now refuses a `dataSources[]` entry with a key the schema does not name, instead of dropping the key silently. A credit placed under `attributionText` was lost this way; the manifest field for credit text is `attribution`. Rename or remove unknown keys in each static data source before validating or packaging with `openmapx-ext`. The authoring JSON schema marks data sources `additionalProperties: false`. Sources an integration supplies at runtime through `ctx.setDataSources()` still drop unknown keys.
