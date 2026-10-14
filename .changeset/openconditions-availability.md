---
"@openmapx/integration-framework": minor
"@openmapx/api": patch
"@openmapx/integration-crowd-reports": patch
---

Add `HttpClient.postResponse()` for bounded JSON POSTs whose non-success status
matters. The crowd-reports relay now uses the host client, so contributions-api
answers keep their status and JSON body while redirects, non-JSON answers and
oversized bodies are refused.
