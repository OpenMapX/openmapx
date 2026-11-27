---
"@openmapx/extension-cli": minor
---

Package and validate integrations that ship backend code. A manifest declaring
`backend.entry: "dist/backend/index.mjs"` gets its prebuilt bundle (at most 32 MiB)
packaged; `database.migrations: true` packages the `migrations/NNNN_name.sql` files,
which must be numbered in sequence (at most 200 files of 1 MiB each); files below
`assets/` that match the archive layout are packaged (at most 512 files of 8 MiB
each), and a layer-selector preview may be stored under `assets/`.

`openmapx-ext package` now refuses: a declared `backend.entry` whose bundle was not
built ("Manifest declares backend.entry but dist/backend/index.mjs is missing"), a
bundle the manifest does not declare, a `migrations/` directory without
`database.migrations: true`, a native add-on (`*.node`) anywhere outside the root
`node_modules/` and `.git/`, and an artifact larger than an install accepts. Root
`index.ts`/`index.js` and other authoring sources are left behind instead of
refusing the package. Frontend code is still refused, with a new message. Update
scripts that match the old "declarative-only" messages.

The provider HTTP policy recognises `fetchJson` imported from
`@openmapx/core/http/fetchJson` and no longer lists
`@openmapx/integration-weather/lib`; use `fetchJsonWithTimeout` from
`@openmapx/integration-sdk/weather`.
