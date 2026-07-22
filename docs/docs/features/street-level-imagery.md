---
title: Street-level imagery
description: Browse ground-level photos on the map, powered by Panoramax and other open imagery platforms.
sidebar_position: 6
---

# Street-level imagery

Street-level imagery lets you drop down to the ground and look around. A
coverage layer paints the streets where photos exist, and clicking a covered
spot opens an immersive, pannable viewer — the open-data equivalent of dragging
a little figure onto the map to see what a place actually looks like.

The default provider is [Panoramax](https://panoramax.xyz/), an open, federated
street-level imagery network run by IGN and OpenStreetMap France. It needs no
credentials, so the feature works out of the box. OpenMapX never hosts the
photos itself; it reads coverage and imagery from the configured provider on
demand, proxied through its own API.

Several providers can be enabled at once. Their coverage renders together on one
layer, colour-coded per provider, and the viewer moves between them seamlessly.

## What you get

- **A coverage overlay** — a "street-level imagery" layer you toggle from the
  [layer selector](./map-layers.md). It draws photo sequences as lines and
  individual photos as dots, with a separate marker style for 360° panoramas, so
  you can see at a glance where imagery is available. Each enabled provider gets
  its own colour.
- **An immersive viewer** — click any covered point and a full-screen viewer
  opens over the map. You can pan and look around, follow the clickable arrows
  to move down the street, and read the reverse-geocoded address, capture date
  and licence of the current photo.
- **Photos on place panels** — companion integrations surface nearby
  street-level photos directly in a place's detail panel, alongside the rest of
  the [place information](./places.md). This is independent of the coverage
  overlay and can be enabled on its own.

## Providers

| Provider  | Default  | Credentials  | Notes                                                                  |
| --------- | -------- | ------------ | ---------------------------------------------------------------------- |
| Panoramax | Enabled  | None         | Open STAC API. Self-hostable. Imagery under CC BY-SA 4.0 or Etalab 2.0. |
| Mapillary | Disabled | Access token | Opt-in. Review its Terms before enabling — see below.                   |

Set the active providers, in priority order:

```bash
# infra/docker/.env
INTEGRATION_STREET_LEVEL_IMAGERY_PROVIDER=panoramax,mapillary
```

A provider that is installed but not listed here stays inactive.

:::caution[Mapillary is opt-in for a reason]
Mapillary's imagery is openly licensed (CC BY-SA 4.0), but its **platform Terms**
prohibit use "in connection with real-time navigation or route guidance" and
require applications to materially supplement Mapillary rather than replicate it.
OpenMapX is a navigation product, so Mapillary ships **disabled by default**.
Review those terms against your own deployment before enabling it. Mapillary is
also API-only — there is no self-hostable fallback.
:::

### Enabling Mapillary

Enable the integration in the admin panel and give it an access token, or set it
from the environment (an environment value always wins over the admin-panel
value):

```bash
# infra/docker/.env
INTEGRATION_STREET_LEVEL_IMAGERY_MAPILLARY_ACCESSTOKEN=MLY|<app_id>|<token>
INTEGRATION_PHOTOS_MAPILLARY_ACCESSTOKEN=MLY|<app_id>|<token>
```

Then add `mapillary` to `INTEGRATION_STREET_LEVEL_IMAGERY_PROVIDER`. With no token
configured, the integration's backend routes return a "not configured" response
and its coverage stays empty — nothing breaks, it is simply inactive.

The token stays server-side. Imagery is proxied through the OpenMapX API, so no
provider token is bundled into the browser JavaScript.

### Pointing Panoramax at your own instance

Panoramax is federated, and its server software is open source. To avoid
depending on a public instance, run your own and set the integration's
`instanceUrl` in the admin panel:

```
https://your-panoramax-instance.example/api
```

Any STAC-compatible Panoramax instance works. The licence of the imagery you get
depends on the instance you point at.

## How it works

Every provider is an integration implementing a shared `StreetLevelProvider`
contract and exposing the same routes under
`/api/integrations/street-level-imagery-<provider>/`:

| Route                | Purpose                                            |
| -------------------- | -------------------------------------------------- |
| `/capabilities`      | Coverage tile descriptor, colour, licence, privacy |
| `/tiles/{z}/{x}/{y}` | Coverage vector tiles, proxied                     |
| `/nearest`           | Nearest image to a coordinate                      |
| `/images/:id`        | One image's metadata and assets                    |
| `/images/:id/links`  | Navigable neighbours for the viewer's arrows       |

The web app talks only to these routes, so it never needs to know which provider
is behind them.

Images are addressed by a provider-qualified reference — `panoramax:<id>` — which
is also what deep links carry (`?sv=panoramax:<id>`). Because the viewer's
internal node ids use the same form, an arrow can lead from one provider's
imagery straight into another's.

### Navigation arrows

The viewer places up to six arrows, one per compass sector, computed the same
way for every provider: sequence continuations win over neighbouring sequences,
and between two neighbours the more recent capture wins, falling back to the
nearer one on the same day. Providers that expose no cross-sequence neighbours
simply yield fewer arrows — the interaction is identical.

## Privacy

Coverage tiles and image metadata are proxied through the OpenMapX API. The
imagery itself is loaded directly from the provider, so the first time you open
the viewer for a given provider you are asked to confirm. Until you do, no
request reaches that provider — including via an arrow that would cross into it.
Each provider is confirmed separately.

Attribution for every visible provider is shown on the map, as their licences
require.
