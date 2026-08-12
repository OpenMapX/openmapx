---
"@openmapx/integration-framework": minor
"@openmapx/core": minor
---

Add solar and time zone helpers, and forward request headers to integration routes.

`@openmapx/core` gains solar-position and twilight-contour geometry (`solarPosition`, `subsolarPoint`, `antisolarPoint`, `solarAltitudeDeg`, `normalizeLongitude`, `darkRegion`, `twilightBands`) and time zone offset helpers (`tzOffsetMinutes`, `tzOffsetLabel`, `tzDiffMinutes`, `viewerTimeZone`, `formatInTimeZone`). The offset helpers return `null` rather than throwing for a zone id the platform does not recognise, and fall back to `shortOffset` on engines that lack `longOffset`.

`@openmapx/integration-framework` adds `headers` to a route handler's request. Handlers previously had no access to request headers, which made conditional GET impossible for every integration. The field is required and always supplied by the host; header names arrive lowercased, per Node. This is a breaking change only for code that *constructs* a request object — in practice, tests.
