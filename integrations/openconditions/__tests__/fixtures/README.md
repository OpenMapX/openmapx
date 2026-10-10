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
