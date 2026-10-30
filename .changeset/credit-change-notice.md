---
"@openmapx/extension-contracts": minor
---

Add `Attribution.modified`: a receipt whose data the result shows changed from what the source published (normalised, combined or derived). Credits then say "data modified" beside that source, as change-notice licences such as CC BY 4.0, the Datenlizenz Deutschland and GeoNutzV require. `parseContributors` keeps the flag and rejects any value other than `true`.
