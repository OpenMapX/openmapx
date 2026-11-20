---
impacts: [operator-action]
---

## What changes

MapTiler geocoding on the deployment's `MAPTILER_KEY` now spends the same daily
budget as the MapTiler asset proxy. When `MAPTILER_DAILY_REQUEST_LIMIT` is set,
search and autocomplete lookups count against it, and once it is spent MapTiler
results are left out of search until the budget resets. Without the variable
nothing changes. A separate geocoding `apiKey` in the integration's
configuration does not spend that budget.

The MapTiler geocoding key now belongs to the integration's current
configuration, so a configuration reload no longer keeps an older key.

## Who is affected

Installations that enable MapTiler geocoding on the shared `MAPTILER_KEY` and
set `MAPTILER_DAILY_REQUEST_LIMIT`.

## Required action

Raise `MAPTILER_DAILY_REQUEST_LIMIT` by the number of MapTiler searches you
expect a day, or leave it unset.
