---
"@openmapx/cli": minor
"@openmapx/core": minor
---

Make service builds portable between hosts. OSRM, OTP, Pelias, and TileServer
builds now stage into `<dir>.next` and only replace the live artifact on
success. Every build records its region, source PBF, revision, and bound runtime
images, and the new `data export` / `data import` commands move a build to
another host as a checksummed tar bundle, refusing it when the serving host
runs different runtime images. `services build motis --import` runs the MOTIS
import with the runtime image so it can happen off-box. Planetiler gets a heap
sized to the extract (`PLANETILER_JAVA_TOOL_OPTIONS`), a persistent work dir for
sources and temp files (`PLANETILER_WORK_DIR`), and the `array` node map only
for the planet; the OTP build heap is set with `OTP_BUILD_JAVA_TOOL_OPTIONS`.
The Pelias Elasticsearch index moves from a named volume into
`data/pelias/elasticsearch`, and manifests gain digest-pinned `buildImages` for
Planetiler and the Pelias importers.
