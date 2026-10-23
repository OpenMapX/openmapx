---
title: Weather
description: Current weather, forecasts, marine conditions, and tides from the instance's configured providers.
sidebar_position: 11
---

# Weather

OpenMapX shows current weather for the map view and selected places. Coastal
places can also show sea conditions and tide information. Precipitation radar
and weather warnings are available as map layers where their sources have
coverage.

Weather API requests pass through OpenMapX's server to the selected provider.
A hosted provider receives the requested location from that server. Check the
source credit and observation time; a forecast is not a measurement at your
exact position.

## What you get

- **Current conditions**: temperature, "feels like," humidity, pressure, wind
  speed and direction, cloud cover, and a condition icon for a point on the map.
- **Forecast**: hourly (up to 168 hours) and daily (up to 16 days) outlooks for
  a location, exposed by the API for any feature that needs them.
- **Air quality**: a separate, lazy place section and map overlay for regional
  standards, raw pollutant evidence, forecasts, and station coverage. See the
  [air-quality platform](./air-quality.md); it is not calculated by Weather.
- **Marine and tides**: wave height, swell, sea state, and surface currents for
  coastal points, plus high/low tide times and water levels from regional gauge
  networks. These appear only where there's data, so inland places stay clean.
- **Map overlays**: a radar loop, temperature/cloud/wind/pressure tiles, and
  active weather alerts, toggled from the layer picker (see
  [Map layers & overlays](./map-layers.md)).

## The weather widget

On desktop, a rounded chip sits near the top-left of the map showing the current
temperature, a short description, and the humidity and wind for the **center of
your current view**. It updates as you pan (debounced, so it isn't chatty) and
only appears once you've zoomed in far enough that a single reading is
meaningful. Hover it to see who published the data; the credit is required by
the upstream license and also joins the on-map attribution strip while the
reading is shown.

The same current-conditions block appears inside a [place](./places.md) panel
when you select somewhere, this time anchored to that place's coordinates rather
than the map center.

## How it works

OpenMapX tries eligible weather providers in priority order and returns the
first answer. A provider error can advance to the next source. Current weather
and forecasts are cached briefly, so a new view need not trigger a new upstream
observation. Source policy can exclude a provider.

### Forecast providers

OpenMapX ships four weather forecast providers. Air quality is a separate
evidence platform and provider domain.

| Provider        | Integration              | Upstream                    | Coverage | API key | Priority |
| --------------- | ------------------------ | --------------------------- | -------- | ------- | :------: |
| **Bright Sky**  | `weather-bright-sky`     | DWD, via Bright Sky         | Germany  | No      |    3     |
| **OpenWeather** | `weather-openweathermap` | OpenWeatherMap              | Global   | **Yes** |    5     |
| **MET Norway**  | `weather-met-norway`     | MET Norway Locationforecast | Global   | No      |    8     |
| **Open-Meteo**  | `weather-open-meteo`     | Open-Meteo                  | Global   | No      |    10    |

Lower priority numbers are tried first. With the defaults, Bright Sky is tried first and can answer around Germany.
MET Norway and Open-Meteo provide broader fallback coverage. OpenWeather slots in between when you've
configured a key. Without one, that provider is not registered.

Air quality has [separate providers and evidence rules](./air-quality.md).
It is not derived from the weather reading.

:::note[License notes]
Open-Meteo's free tier is licensed for non-commercial use only. Commercial
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
  Level Monitoring facility. The result identifies the responding network and station. NOAA, Canada, and
  Norway can supply predictions; Pegelonline and IOC provide observations and
  derived past extrema. A recent high or low from observations is not a
  prediction of the next tide.

Both are keyless and, like the rest of weather, are fetched through your server.

## Configuring providers

Each provider is an [integration](../overview/how-it-works.md), so it's enabled,
disabled, and configured the same way as any other. Three providers work out of
the box with no setup: MET Norway, Open-Meteo, and Bright Sky (the latter only
matters if you serve users in Germany). The orchestrator tries the enabled providers in their adapter priority order.
Enable or disable providers to change the eligible set; numeric priority is not
an exposed per-provider admin setting.

The only provider that needs a credential is **OpenWeather**, which requires a
OpenWeatherMap API key. Set it in either place:

- the admin panel, under the `weather-openweathermap` integration's config form,
  where it's stored as an encrypted secret; or
- the environment, as `INTEGRATION_WEATHER_OPENWEATHERMAP_APIKEY` in
  `infra/docker/.env`.

The **map overlay** (`overlay-weather`) has its own distinct OpenWeatherMap
configuration setting, `owmApiKey` (environment variable
`INTEGRATION_OVERLAY_WEATHER_OWMAPIKEY` in `infra/docker/.env` or set in the admin panel).
When configured, it unlocks precipitation, temperature, cloud, wind, and pressure tile
layers. If an OpenWeather sublayer is selected while unconfigured or unavailable,
the UI automatically falls back to the RainViewer radar loop. Its radar loop works out
of the box without any key (and fails with HTTP 451 if RainViewer is disallowed by data-use
policy). See [Map layers & overlays](./map-layers.md) for the overlay side, and
[Configuration](../install/configuration.md) for how integration settings and
secrets resolve in general.

:::note[Weather data needs no backend service]
Weather providers call forecast APIs through your server. They do not require a
local weather engine in your [service selection](../install/managing-services.md).
:::

## Related features

- [Map layers & overlays](./map-layers.md): the weather radar, tile, and alert
  overlays, plus the nautical overlay.
- [Places](./places.md): where per-place current conditions, sea state, and
  tides appear.
- [Search](./search.md) and [directions](./directions.md): the rest of the map
  application weather sits alongside.
