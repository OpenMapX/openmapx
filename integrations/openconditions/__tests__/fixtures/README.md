# OpenConditions fixtures

The hazards fixtures are OpenConditions answers built, not recorded from a running instance. They
were made on 2026-10-09 by running the real parsers of the OpenConditions `packages/hazards` over
that package's own captures of the publishers' feeds (`packages/hazards/src/__tests__/fixtures/`,
captured 2026-09-29 to 2026-10-08, see the README there for each URL), sealing every draft with
`sealRecord` against the kernel and the hazards model (instance `hazards.example`, revision 1), and
wrapping the sealed records in the envelope the API serves. No OpenConditions service ran.

- `situations-alerts.json`: the `GET /situations?domain=hazards&kind=alert` answer, `{ records, next }`.
  One MeteoAlarm warning (Austria, an EMMA area with the shape derived from the geocode file;
  `eu-meteoalarm-alerts` carries a notice), one MeteoAlarm warning (France, NUTS3 codes only, so
  `geometry: null`) and one NWS alert (`us-nws-alerts`, no notice).
- `situations-natural.json`: the `GET /situations?domain=hazards&kind=natural_hazard` answer. Five
  USGS earthquakes (one with `tsunamiFlag`), a NIFC wildfire perimeter (MultiPolygon), a NOAA HMS
  smoke polygon, and two ended NASA EONET events (a volcano and an iceberg). Geometry is as stored;
  the `simplify` parameter is not applied.
- `observations-fire.json`: the `GET /observations/latest?property=fire.frp` answer. Seven VIIRS
  pixels (`nasa-firms-viirs-fires`, NOAA-21 and NOAA-20) and three MODIS pixels
  (`nasa-firms-modis-fires`). The pixels are old captures; the test judges none by age.
- `observations-grid.json`: the `GET /observations/grid?property=fire.frp&cellDeg=1` answer,
  constructed: the ten pixels above counted, summed and maximised per 1° cell with the centre
  rounding `readGrid` uses (cell centre at `(floor(x / cellDeg) + 0.5) * cellDeg`).
- `sources-hazards.json`: the `GET /sources` answer in the operator scope for the twelve hazards
  feeds of the OpenConditions catalogue (`feeds/hazards/`), produced by OpenConditions' `sourcesOf`:
  `format`, `qualifier` and, for `eu-meteoalarm-alerts`, the publisher's `notice`.

The message-sign fixture is a documented sample built by hand, not recorded:

- `features-signs.json`: the `GET /features?kind=vms&canonical=1&expand=components,latest` answer
  for two signs in the shape OpenConditions' `cars-signs` parser writes (`packages/roads/src/cars-signs.ts`,
  2026-10-14): one `vms` feature with its `sign_face` component `0` and the newest `vms.display`
  reading of that face. The first sign shows a two-page message, the second is blank. The sign ids,
  names, places and messages are invented; the 511NY Developer Access Agreement does not allow
  publishing the feed's records.

The road-weather, vehicle and border fixtures are OpenConditions answers built, not recorded from a
running instance. They were made on 2026-10-15 from OpenConditions 2c917527 (its station status,
sanding and vehicle trail changes) by running the real parsers of `packages/weather`,
`packages/vehicles` and `packages/border` over those packages' own captures of the publishers'
feeds (`src/__tests__/fixtures/` in each, captured 2026-10-14 and 2026-10-15, see the README there
for each URL), stamping each draft's attribution with the ingest pipeline's
`stampAttribution` and sealing it with `sealRecord` against the production registry (instance
`conditions.example`, revision 1). No OpenConditions service ran. All four feeds are open data
(CC BY 4.0, OGL – Canada 2.0, U.S. Government public domain).

- `features-weather.json`: the `GET /features?kind=weather_station&canonical=1&expand=components,latest`
  answer for four Digitraffic stations: Nupuri (1001), with air values and two dry surface sensors
  (so no salt or freezing point) and device status `ok`; Vuosaari (1071), temporarily closed,
  `offline` and without other readings; Kousa (7037), whose interrupted repair is a `warning` and
  whose values are too old to be read; and Lapinlahti (8003), with a salted, chemically wet surface
  and no stated status. The station kind has no linking, so each is its own feature. A change-only
  reading (`road.surface_state`, `weather.precipitation_type`) carries the `validUntil` its feed's
  polling gives it: the fetch plus the longer of 30 minutes and twice the cadence; a
  `device.status`, written with the daily station list, carries the fetch plus two days.
- `features-border.json`: the `GET /features?kind=border_crossing&canonical=1&expand=components,latest`
  answer for five crossings. The CBP and CBSA features were linked with `proposeLink` and the
  kind's linking rules, clustered with `canonicalClusters` and composed with
  `canonicalComponents` and `canonicalFeatureRecord`, as the canonical view composes them: the
  Peace Bridge and the Thousand Islands Bridge carry both agencies' queues (CBSA survives, so
  CBP's are keyed `us-cbp-waits/<key>`), Douglas (Arizona) and Calais: Milltown (closed) are CBP's
  only, and Emerson is CBSA's only. Each reading is keyed by the canonical component it stands in.
- `observations-vehicles.json`: the `GET /observations/latest?property=vehicle.position` answer, the
  eight trackings of the live capture still in effect at its fetch, one of them sanding. None
  ploughs; the tests set a plough on one.
- `observations-vehicles-trails.json`: the same answer for the paired capture of latest points and
  routes (fetched 2026-10-15T07:04:51Z): five positions, two with a trail, one ploughing.
- `sources-conditions.json`: the `GET /sources` answer in the public scope for the four feeds,
  produced by OpenConditions' `sourcesOf`.
