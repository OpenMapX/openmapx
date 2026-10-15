---
"@openmapx/integration-openconditions": patch
---

A change-only OpenConditions reading (a road's surface state, the precipitation
type, a crossing's open status, a station's device status) is current while the
`validUntil` OpenConditions serves it with lies ahead, however long ago the value
last changed. A road dry for hours keeps its colour and filter, and a port closed
for days keeps showing closed; measured values and border waits still age out.
