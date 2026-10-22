---
impacts: [breaking, operator-action]
---

## What changes

All MBTA transit requests now require a configured API key and working shared
request admission. Alerts, vehicles and facilities no longer fall back to
anonymous requests. Each integration instance owns its key and cancellation
lifetime. Failed or incomplete acquisitions remain errors rather than successful
empty or partial data.

Nearby-stop searches now enforce the requested distance in metres. Departure
destinations and platforms use the documented trip/stop fields. Invalid positions
or missing vehicle observation times are omitted instead of replaced with zero
coordinates or the current time.

## Who is affected

Installations using the built-in MBTA transit integration, including those that
previously requested only alerts, vehicles or facilities without a key.

## Required action

Configure a valid MBTA API key and keep the existing Redis-backed upstream runtime
available. Use a dedicated key when possible: OpenMapX coordinates its own requests
across replicas but cannot count another application's traffic using that key.
There is no data migration. No action is required when MBTA is disabled.
