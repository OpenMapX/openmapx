---
"@openmapx/integration-framework": minor
"@openmapx/api": patch
"@openmapx/integration-crowd-reports": patch
"@openmapx/integration-road-conditions": patch
"@openmapx/integration-overlay-traffic-flow": patch
"@openmapx/i18n": patch
---

Add `HttpClient.postResponse()` for bounded JSON POSTs whose non-success status
matters. The crowd-reports relay now uses the host client, so contributions-api
answers keep their status and JSON body while redirects, non-JSON answers and
oversized bodies are refused.

Road-condition events answer 503 when no road-conditions source is configured,
so the map legend and navigation report incidents as unavailable instead of
reading the road as clear. The traffic-flow legend likewise says its data is
unavailable when Martin does not serve the flow source or its tiles fail.
