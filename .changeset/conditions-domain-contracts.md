---
"@openmapx/mobility-core": minor
"@openmapx/integration-framework": minor
"@openmapx/api": minor
---

Add three provider capabilities: `road-weather` (`RoadWeatherStation`, the
surface and air values a road weather station measures), `service-vehicles`
(`ServiceVehicle`, an anonymous road service vehicle position with the work it
reports) and `border-crossings` (`BorderCrossing`, each queue's wait in each
direction). Each has its contract, a typed registrar stored under its domain
key, and a slot in the mock integration context.
