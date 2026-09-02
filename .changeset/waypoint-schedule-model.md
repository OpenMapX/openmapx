---
"@openmapx/core": minor
---

Add the per-waypoint schedule model and solver: `WaypointSchedule` constraints
on `Waypoint`, `TemporalCapabilities` for declaring provider support,
`resolveScheduleConstraints` for turning wall clocks into validated instants,
`composeSchedule` for the canonical `TripSchedule`, and `planScheduledTrip` for
driving a per-leg travel oracle. Also adds `RoutingOptions.dwellSeconds`, the
`isoWithOffsetInZone` timezone helper, and the scheduled-directions client
surface (`ScheduleDirectionsRequest`, `ScheduledDirectionsResult`,
`postScheduledDirections`) against the new `POST /directions/schedule` endpoint.
