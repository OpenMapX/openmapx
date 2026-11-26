---
"@openmapx/extension-contracts": minor
"@openmapx/extension-cli": minor
---

Extension protocol 1.0 gains the fields installed code needs, and drops three
that never worked. Integration manifests: `backend.entry`, `frontend.entry`,
`webPlatform`, `database.migrations`, `frontend.panel` as an object with an
optional `detents`, `frontend.mapControl`, `frontend.legendKind`,
`frontend.overlay.id`, `frontend.layerSelector.section`,
`dataSources[].logoAsset` and `subjectData.registrations`; `backend.cron` is
removed. Service manifests: a `requests` object for host paths, platform
services, reachability and database roles; `exposure.proxy.authRequired` is
removed; `ownsSchema` must start with a letter and have at most 63 characters.
Extension manifests: `config[]` entries name one lowerCamel key and
its `targets` (a component setting or a capability), and may be `secret` and
`generated`; `services[].optional`, `changelog` and `webPlatform` are new;
`readiness` is removed. Verified catalogue entries may set `prerelease`,
`webPlatform` and `changelog`. New subpaths:
`@openmapx/extension-contracts/grants` and `/archive`.

To update: replace `config[].target` with `targets: [{ component, key }]`,
write `config[].key` in lowerCamel, replace `"panel": true` with `"panel": {}`
and delete `"panel": false`, `readiness`, `backend.cron` and `authRequired`.
Rename an `ownsSchema` that starts with `_` or is longer than 63 characters.
`openmapx-ext validate` names each of them.
