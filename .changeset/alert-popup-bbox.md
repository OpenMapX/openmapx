---
"@openmapx/integration-overlay-weather-alerts": patch
"@openmapx/integration-road-conditions": patch
---

Close a weather alert's popup once its alert expires, leaves the feed or has its severity hidden, instead of showing it after the alert is gone. The road-conditions bbox parser again matches OpenConditions' copy and rejects a repeated `bbox` parameter.
