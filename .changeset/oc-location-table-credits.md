---
"@openmapx/integration-openconditions": patch
---

OpenConditions records placed with a third-party location table now credit it.
A hazards record or road event whose `location.locationTable` states a notice
carries one more contributor under its feed id, named after the table edition,
with the notice verbatim and the table's licence: an SPDX id as itself,
`LicenseRef-OD-HR` as the Croatian Open Licence. Croatian MeteoAlarm warnings
drawn from the State Geodetic Administration's county outlines thus show DGU's
Open Licence notice in the map credits, and TMC-placed road events credit their
location code list.
