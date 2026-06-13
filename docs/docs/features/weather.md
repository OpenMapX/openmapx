---
title: Weather
description: Current conditions and forecasts for any point on the map, plus marine and tide data on the coast — served through a configurable provider chain.
sidebar_position: 11
---

# Weather

OpenMapX shows you the weather without sending your users to a third-party
service. A small **weather widget** floats over the map with the current
conditions for wherever you're looking, and opening a place reveals its current
weather alongside — on the coast — sea state and tide information. Animated
precipitation radar and severe-weather warnings live one level up, as map
overlays.

Every reading is fetched server-side: the browser asks your API, your API asks
the upstream forecast service. Providers see your server, not your visitors.

## What you get

- **Current conditions** — temperature, "feels like," humidity, pressure, wind
  speed and direction, cloud cover, and a condition icon for a point on the map.
- **Forecast** — hourly (up to 168 hours) and daily (up to 16 days) outlooks for
  a location, exposed by the API for any feature that needs them.
- **Air quality** — particulate, gas, and AQI readings (European and US scales)
  from a dedicated air-quality endpoint.
- **Marine and tides** — wave height, swell, sea state, and surface currents for
  coastal points, plus high/low tide times and water levels from regional gauge
  networks. These appear only where there's data, so inland places stay clean.
- **Map overlays** — a radar loop, temperature/cloud/wind/pressure tiles, and
  active weather alerts, toggled from the layer picker (see
  [Map layers & overlays](./map-layers.md)).

## The weather widget

On desktop, a rounded chip sits near the top-left of the map showing the current
temperature, a short description, and the humidity and wind for the **center of
your current view**. It updates as you pan (debounced, so it isn't chatty) and
only appears once you've zoomed in far enough that a single reading is
meaningful. Hover it to see who published the data — the credit is required by
the upstream license and also joins the on-map attribution strip while the
reading is shown.

The same current-conditions block appears inside a [place](./places.md) panel
when you select somewhere, this time anchored to that place's coordinates rather
than the map center.

## How it works

A single **weather** integration is the orchestrator. It doesn't talk to any
upstream itself — it discovers the forecast *providers* that are enabled and
queries them in turn. Each provider is its own integration that registers under
the `weather` domain and declares a numeric **priority**; the orchestrator sorts
them low-to-high and walks the list:

1. Ask the highest-priority eligible provider.
2. If it throws, times out, or has no data for the point, fall through to the
   next one.
3. Return the first successful answer; if none answer, the request returns a
   502.

That fallback is what makes a region-specific provider safe to put first. Bright
Sky, for example, only has data for Germany (it serves Germany's national weather
service, the DWD), so it sits at the top of the chain — when you're in Germany it
answers, and everywhere else it simply throws and the next provider takes over.

Providers are also subject to your data-use policy: if an operator has disallowed
a provider's data source, the orchestrator skips it exactly as if it had errored,
so a gated source never gets queried.

The current-conditions and forecast endpoints are cached briefly (five and ten
minutes respectively) and keyed by rounded coordinates, so nearby lookups and
repeat views are cheap.

### Forecast providers

OpenMapX ships five weather integrations. Four are forecast providers in the
chain; the fifth supplies air quality through its own route.

| Provider | Integration | Upstream | Coverage | API key | Priority |
| --- | --- | --- | --- | --- | :-: |
| **Bright Sky** | `weather-bright-sky` | DWD, via Bright Sky | Germany | No | 3 |
| **OpenWeather** | `weather-openweathermap` | OpenWeatherMap | Global | **Yes** | 5 |
| **MET Norway** | `weather-met-norway` | MET Norway Locationforecast | Global | No | 8 |
| **Open-Meteo** | `weather-open-meteo` | Open-Meteo | Global | No | 10 |
| **Air quality** | `weather-open-meteo-air-quality` | Open-Meteo Air Quality | Global | No | — |

Lower priority numbers are tried first. With the defaults, a point in Germany is
answered by Bright Sky; everywhere else falls to MET Norway, and Open-Meteo is
the last-resort global fallback. OpenWeather slots in between when you've
configured a key — without one, that provider isn't registered at all, and the
chain skips straight past it.

The air-quality integration isn't part of the forecast chain. It registers a
separate endpoint that returns particulate matter, nitrogen dioxide, ozone,
sulphur dioxide, carbon monoxide, and both the European and US AQI for a point,
sourced from Open-Meteo's air-quality model.

:::note[License notes]
Open-Meteo's free tier is licensed for non-commercial use only — commercial
deployments need a paid Open-Meteo plan. MET Norway and Bright Sky carry their
own attribution requirements, which OpenMapX surfaces automatically wherever
their data is shown. The data source's attribution and license terms travel with
the reading.
:::

### Marine weather and tides

Where a place sits on or near the water, two extra sections can appear in its
panel.

- **Sea conditions** come from the `knowledge-marine-weather` integration, which
  reads Open-Meteo's marine grid: wave height, swell, surface-current velocity,
  and a Douglas sea-state badge, with a short wave-height sparkline. Open-Meteo's
  marine model returns no data for inland points, so this section renders only
  when the upstream actually had a reading for the spot.
- **Tides** come from a small chain of regional gauge networks, each its own
  `knowledge-tides-*` integration: NOAA CO-OPS (US coasts), Fisheries and Oceans
  Canada, Norway's Kartverket, Germany's WSV Pegelonline, and the global IOC Sea
  Level Monitoring facility. The first one with a station near the point answers,
  and the resulting high/low times and water levels are credited to whichever
  network actually responded.

Both are keyless and, like the rest of weather, are fetched through your server.

## Configuring providers

Each provider is an [integration](../overview/how-it-works.md), so it's enabled,
disabled, and configured the same way as any other. Three providers work out of
the box with no setup: MET Norway, Open-Meteo, and Bright Sky (the latter only
matters if you serve users in Germany). The orchestrator picks whichever enabled
provider answers first for a given point — to prefer a different source, enable
or disable providers, or adjust their priorities.

The only provider that needs a credential is **OpenWeather**, which requires a
free OpenWeatherMap API key. Set it in either place:

- the admin panel, under the `weather-openweathermap` integration's config form,
  where it's stored as an encrypted secret; or
- the environment, as `INTEGRATION_WEATHER_OPENWEATHERMAP_APIKEY` in
  `infra/docker/.env`.

The same key also unlocks the **map overlay's** temperature, cloud, wind, and
pressure tiles, configured separately on the `overlay-weather` integration (its
radar loop works without any key). See
[Map layers & overlays](./map-layers.md) for the overlay side, and
[Configuration](../install/configuration.md) for how integration settings and
secrets resolve in general.

:::note[Weather data needs no backend service]
Unlike routing or transit, weather has no self-hosted engine to run — every
provider calls a public forecast API through your server. There's nothing to add
to your [service selection](../install/managing-services.md); enabling the
integrations is all it takes.
:::

## Related features

- [Map layers & overlays](./map-layers.md) — the weather radar, tile, and alert
  overlays, plus the nautical overlay.
- [Places](./places.md) — where per-place current conditions, sea state, and
  tides appear.
- [Search](./search.md) and [directions](./directions.md) — the rest of the map
  application weather sits alongside.
