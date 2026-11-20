---
impacts: [breaking]
---

## What changes

Every API error reply now has one shape, `{ error, code? }`: `error` is a short,
user-safe description and `code` an optional stable reason. Replies that used
`message` for that text now use `error`, among them the tile, image, MapTiler,
Mapterhorn, traffic and winter-sports proxies and the overlay, weather, tide,
sun-time and street-level imagery integrations.

The air-quality and OpenStreetMap contribution errors keep their codes and their
other fields and rename `message` to `error`. Managed Dawarich, privacy
administration and privacy request errors and the wildfire layers' unavailable
reply add `error` beside their `code`. Integration and service configuration
validation adds `error` beside its `errors` list.

## Who is affected

Scripts or separately deployed clients that read `message` or rely on a bare
`code` in an API error body. The OpenMapX web and mobile apps change together
with the API.

## Required action

Read the error text from `error` and keep branching on `code`. Upgrade API and
application clients together. No migration or configuration change is needed.
