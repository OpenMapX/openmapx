---
"web": patch
"@openmapx/integration-overlay-cycling": patch
"@openmapx/integration-overlay-earthquakes": patch
"@openmapx/integration-overlay-environment": patch
"@openmapx/integration-overlay-hiking": patch
"@openmapx/integration-overlay-live-transit": patch
"@openmapx/integration-overlay-natural-events": patch
"@openmapx/integration-overlay-nautical": patch
"@openmapx/integration-overlay-ourairports": patch
"@openmapx/integration-overlay-satellite": patch
"@openmapx/integration-overlay-schematic-transit": patch
"@openmapx/integration-overlay-sun-time": patch
"@openmapx/integration-overlay-tool-measurement": patch
"@openmapx/integration-overlay-tool-travel-time": patch
"@openmapx/integration-overlay-transit": patch
"@openmapx/integration-overlay-weather": patch
"@openmapx/integration-overlay-weather-alerts": patch
"@openmapx/integration-overlay-wildfires": patch
"@openmapx/integration-overlay-winter-sports": patch
"@openmapx/integration-road-conditions": patch
---

Map overlays now keep their layers and data across style changes through one shared lifecycle, recolour and refilter without blinking, stack in a fixed order, and leave the map clean when switched off, while style updates no longer copy the whole map style on every change.
