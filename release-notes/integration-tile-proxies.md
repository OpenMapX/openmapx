---
impacts: [security, operator-action]
---

## What changes

The hiking, winter sports, satellite, weather, street-level imagery, schematic
transit and nautical tile relays now reject coordinates outside the Web
Mercator grid before making an upstream request. A path parameter can no
longer steer an OpenWeatherMap request (which carries your key) or a NASA GIBS
request to another path on that provider.

All of these relays now share one implementation with fixed deadlines, media
types and byte ceilings. An upstream 404 answers 404, and every other upstream
failure, including 401, 403 and 429 from a provider that rejected your key or
throttled your instance, answers 502 instead of being passed to the browser.
Error bodies use `{ "error": "..." }`.

The hiking, winter sports, satellite tile, both weather tile and all five
nautical tile routes move from the shared `public` rate limit (600 requests a
minute per client by default) to the `tile` limit (1,800 a minute) that the
other tile relays already use. Map browsing no longer spends the budget that
place lookups, search and directions share.

## Who is affected

Installations that enable any of the overlays above. Operators who lowered
`RATE_LIMIT_PUBLIC_MAX` to restrict these tile routes.

## Required action

None for most installations. If you rely on `RATE_LIMIT_PUBLIC_MAX` to cap
these overlays, set `RATE_LIMIT_TILE_MAX` and `RATE_LIMIT_TILE_WINDOW_MS`
instead; they now govern them. Custom tile URLs must return an image (or, for
vector layers, a vector tile) media type within the existing 8 MiB raster and
2 MiB vector tile ceilings.
