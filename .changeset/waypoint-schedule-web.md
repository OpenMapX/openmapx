---
"@openmapx/core": minor
---

Move the directions trip time into `directionsStore` (`timeMode` / `tripTime`)
so every consumer of the directions cache builds the same request, and add
per-waypoint schedule state (`setWaypointSchedule`, `applyWaypointOrder`,
`hasScheduleConstraints`) plus the `useScheduledDirections` query hook.
`RouteSharePayload` gains optional versioned per-waypoint schedules.
