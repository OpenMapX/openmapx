---
title: Street-level imagery
description: Browse ground-level photos on the map, powered by Mapillary's open imagery platform.
sidebar_position: 5
---

# Street-level imagery

Street-level imagery lets you drop down to the ground and look around. A
coverage layer paints the streets where photos exist, and clicking a covered
spot opens an immersive, pannable viewer — the open-data equivalent of dragging
a little figure onto the map to see what a place actually looks like.

The imagery comes from [Mapillary](https://www.mapillary.com/), a
crowd-sourced, open street-level photo platform. OpenMapX never hosts the photos
itself; it reads coverage and imagery from Mapillary on demand. Because the
feature depends on an external service that needs an access token, it is **off
by default** until you configure it.

## What you get

- **A coverage overlay** — a "street-level imagery" layer you toggle from the
  [layer selector](./map-layers.md). It draws photo sequences as lines and
  individual photos as dots, with a separate marker style for 360° panoramas, so
  you can see at a glance where imagery is available.
- **An immersive viewer** — click any covered point and a full-screen viewer
  opens over the map. You can pan and look around, step along the sequence to
  move down the street, and read the reverse-geocoded address and capture date
  of the current photo.
- **Photos on place panels** — a companion integration surfaces nearby
  street-level photos directly in a place's detail panel, alongside the rest of
  the [place information](./places.md). This is independent of the coverage
  overlay and can be enabled on its own.

## How it works

The feature is delivered by two integrations that both draw on Mapillary:

| Integration               | What it does                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `street-view-mapillary`   | The coverage overlay and the immersive viewer (the main feature on this page).                |
| `photos-mapillary`        | Nearby street-level photos shown on place detail panels.                                       |

Both are first-party, built-in integrations. See
[Introduction](../overview/introduction.md) for what an integration is, and
[How it works](../overview/how-it-works.md) for how integrations consume
services and external APIs.

### Coverage layer

The coverage layer is served as **vector tiles**. When you turn the overlay on,
the web app adds a Mapillary vector source and pulls tiles through your own API
server, which proxies them from Mapillary's tile endpoint. Three layers are
drawn from those tiles: photo sequences (lines), regular photos (small dots),
and 360° panoramas (ringed markers). Only the photo dots are interactive —
clicking one resolves the nearest image and hands it to the viewer.

Routing tile requests through the API server means the upstream provider sees
your server's address rather than each visitor's, in keeping with the
[privacy-by-default](../overview/introduction.md) posture of the rest of the
stack.

### The viewer

The immersive viewer is a browser-side component (built on Mapillary's own
viewer library) that streams imagery directly from Mapillary. Because that's a
direct browser-to-Mapillary connection — unlike the proxied coverage tiles — the
app shows a short notice the first time you open the viewer, explaining that
continuing will contact Mapillary directly, with a link to Mapillary's privacy
policy. Once you confirm, the viewer loads and remembers your choice for the
session.

:::note Two separate tokens
The viewer authenticates with Mapillary from the browser, so it needs a
**client** token that ships in the public JavaScript bundle. That token is
deliberately distinct from the **server-side** token used to proxy coverage
tiles and fetch place photos. Keep them separate, and use a dedicated,
read-only Mapillary app for the client token so the one you expose is the one
you're comfortable exposing.
:::

## Enabling and configuring

You need a Mapillary access token (or two — see above). Create an application on
the [Mapillary developer dashboard](https://www.mapillary.com/developer) to get
one.

### Server-side token (coverage tiles and place photos)

The `street-view-mapillary` and `photos-mapillary` integrations each take an
`accessToken` in their config. Both map to the shared Mapillary token, so you
configure it once. Like every integration secret, it resolves through the config
cascade described in [Managing services](../install/managing-services.md), with
two practical options:

- **Admin panel** — open the integration in the admin UI and paste the token
  into its **Mapillary Access Token** field. It is stored encrypted.
- **Environment variable** — set it in `infra/docker/.env`. The variable name is
  `INTEGRATION_` + the integration id (upper-cased, hyphens to underscores) +
  `_` + the key:

  ```bash
  # infra/docker/.env
  INTEGRATION_STREET_VIEW_MAPILLARY_ACCESSTOKEN=MLY|<app_id>|<token>
  INTEGRATION_PHOTOS_MAPILLARY_ACCESSTOKEN=MLY|<app_id>|<token>
  ```

  An environment value always wins over the admin-panel value.

With no token configured, the integration's backend routes return a
"not configured" response and the overlay stays empty — nothing breaks, the
feature is simply inactive.

### Client token (the in-browser viewer)

The immersive viewer reads a separate **client** token from the web app's
environment, exposed to the browser as `NEXT_PUBLIC_MAPILLARY_TOKEN`. In a
Docker deployment this is fed from `MAPILLARY_VIEWER_TOKEN` in
`infra/docker/.env` (intentionally *not* the server-side token):

```bash
# infra/docker/.env
MAPILLARY_VIEWER_TOKEN=MLY|<app_id>|<token>
```

Leave it unset and the on-map entry point is hidden entirely — the coverage
overlay can still be shown, but there's no way to open the viewer. For the wider
picture of `.env` values and the admin panel, see
[Configuration](../install/configuration.md).

## Attribution and licensing

Mapillary imagery is contributed by its community and is generally licensed
**CC BY-SA 4.0**. The viewer credits Mapillary, and street-level photos shown on
place panels carry per-photo attribution (contributor and license) where it's
available. The Mapillary API itself is governed by Mapillary's own terms;
review them — together with their stance on commercial use — before deploying.

## Related

- [Map layers](./map-layers.md) — where the coverage overlay lives, alongside
  satellite, terrain, and the other map details.
- [Places](./places.md) — the detail panels where nearby street-level photos
  appear.
- [Configuration](../install/configuration.md) — environment variables and the
  admin panel in full.
