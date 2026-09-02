---
"@openmapx/core": minor
---

Add the chained transit-plan client surface: `postTransitChainPlan`,
`useTransitChainPlan` and `transitChainQueryKey` against the new
`POST /transit/plan/chain` endpoint, which plans a multi-stop public-transport
trip around per-waypoint time windows and dwell, plus the `ChainedTripPlan`
types that describe its result.
