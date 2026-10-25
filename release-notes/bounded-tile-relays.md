---
impacts: [security]
---

## What changes

Public cycling, MapTiler and traffic tile relays now reject coordinates outside
their provider's Web Mercator grid before making an upstream request. Relayed
tile and style responses enforce deadlines, expected media types and byte
ceilings, and stop upstream work when the caller disconnects. Invalid provider
responses before the first byte return a fixed, non-cacheable error; later
stream failures terminate the connection instead of serving partial data.

## Who is affected

Installations using the built-in cycling layers, hosted MapTiler fallback or
TomTom traffic-flow overlay.

## Required action

No configuration or data migration is required. Custom tile URLs must return
the documented PNG media type and remain within the existing 8 MiB raster tile
ceiling.
