---
title: Street-level imagery
description: Browse ground-level photos on the map, powered by Panoramax and other open imagery platforms.
sidebar_position: 6
---

# Street-level imagery

Turn on **Street-level imagery** to see streets with photo coverage, then select
a covered point to open the viewer. You can look around and follow available
arrows to nearby images. Coverage, image age, and available directions vary.

Panoramax is enabled by default and needs no credentials. An operator can add
Mapillary separately. Enabled providers share one coverage layer and retain
their own colors and credits.

## What you get

- **A coverage overlay**: a "street-level imagery" layer you toggle from the
  [layer selector](./map-layers.md). It draws photo sequences as lines and
  individual photos as dots, with a separate marker style for 360° panoramas, so
  you can see at a glance where imagery is available. Each enabled provider gets
  its own colour.
- **An immersive viewer**: click any covered point and a full-screen viewer
  opens over the map. You can pan and look around, follow the clickable arrows
  to move down the street, and read the reverse-geocoded address, capture date
  and licence of the current photo. A small synchronized map keeps the current
  image and nearby coverage in view while you move.
- **Photos on place panels**: companion integrations surface nearby
  street-level photos directly in a place's detail panel, alongside the rest of
  the [place information](./places.md). This is independent of the coverage
  overlay and can be enabled on its own.

## Providers

| Provider  | Default  | Credentials  | Notes                                                                   |
| --------- | -------- | ------------ | ----------------------------------------------------------------------- |
| Panoramax | Enabled  | None         | Open STAC API. Self-hostable. Imagery under CC BY-SA 4.0 or Etalab 2.0. |
| Mapillary | Disabled | Access token | Opt-in. Review the provider terms before enabling it.                   |

Enabled providers contribute coverage in their own colors, subject to their
credentials and any explicit provider-order setting.

To pin the set and its priority order explicitly, set:

```bash
# infra/docker/.env
INTEGRATION_STREET_LEVEL_IMAGERY_PROVIDER=panoramax,mapillary
```

When this is set, a provider that is enabled but not listed stays inactive.

:::caution[Mapillary is opt-in for a reason]
Mapillary's imagery is openly licensed (CC BY-SA 4.0), but its **platform Terms**
prohibit use "in connection with real-time navigation or route guidance" and
require applications to materially supplement Mapillary rather than replicate it.
OpenMapX is a navigation product, so Mapillary ships **disabled by default**,
and even when enabled its imagery is never used for the junction photo shown
while navigating. It remains available in the viewer and on place panels.
Review [Mapillary's terms](https://www.mapillary.com/terms) for your deployment before enabling it. Mapillary is
API-only and has no self-hosted fallback.
:::

### Enabling Mapillary

Enable the integration in the admin panel and give it an access token, or set it
from the environment (an environment value always wins over the admin-panel
value):

```bash
# infra/docker/.env
INTEGRATION_STREET_LEVEL_IMAGERY_MAPILLARY_ENABLED=true
INTEGRATION_STREET_LEVEL_IMAGERY_MAPILLARY_ACCESSTOKEN="MLY|<app_id>|<token>"
INTEGRATION_PHOTOS_MAPILLARY_ACCESSTOKEN="MLY|<app_id>|<token>"
```

The overlay/viewer and photos on place panels are separate integrations. They
can use the same token, but it must be configured for each. The enabled flag
opts the overlay/viewer in; setting its token alone does not enable it. After
editing `.env`, recreate the API container with `pnpm openmapx services start
app-api` so it receives the new environment.

When enabled with no token configured, the imagery routes return a "not
configured" response and coverage stays empty. A disabled integration does not
register those routes or appear in the active provider list.

The token stays server-side. Imagery is proxied through the OpenMapX API, so no
provider token is bundled into the browser JavaScript.

### Pointing Panoramax at your own instance

Panoramax is federated, and its server software is open source. To avoid
depending on a public instance, run your own and set the integration's
`instanceUrl` in the admin panel:

```
https://your-panoramax-instance.example/api
```

Use a Panoramax instance compatible with the supported API. The licence of the imagery you get
depends on the instance you point at.

## How it works

The viewer uses provider-qualified image references, including links such as
`?sli=panoramax:<id>`. A link can stop working if its source removes the image
or the instance disables that provider.

### During navigation

The [junction view](./directions.md#turn-by-turn-navigation) can show an available
approach photo while driving. Only providers permitted for navigation are
searched, currently Panoramax. The caption retains author, license, and capture
month. An old photo is not evidence of current lane layout or road conditions.

Junction photos can be disabled in navigation settings. Where no suitable image
exists, navigation keeps its schematic junction view. This is separate from
opening the imagery viewer to browse photos.

### Navigation arrows

The viewer shows up to six directional arrows. Sequence continuations take
priority; nearby sequences can add other directions. An absent arrow can mean
that the provider has no suitable neighboring image, even where a road continues.

## Privacy

Coverage tiles, image metadata, and panorama image assets are proxied through
the OpenMapX API. Providers marked `server-only` therefore open without a
notice: the provider sees the server, not the viewer's IP. If a future or custom
provider exposes browser-loaded assets, OpenMapX shows a per-provider notice
before loading it and also gates arrows that would cross into that provider.

Attribution for every visible provider is shown on the map, as their licences
require.
