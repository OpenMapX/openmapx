---
impacts: [breaking, operator-action]
---

## What changes

Integration settings in the environment split the words of their lowerCamel
config key: `INTEGRATION_<ID>_<KEY_WORDS>`. For example
`INTEGRATION_SEARCH_NLP_RATE_LIMIT_PER_IP_PER_HOUR` (was
`INTEGRATION_SEARCH_NLP_RATELIMITPERIPPERHOUR`),
`INTEGRATION_STREET_LEVEL_IMAGERY_MAPILLARY_ACCESS_TOKEN` (was
`…_MAPILLARY_ACCESSTOKEN`) and `INTEGRATION_GEOCODING_MAPTILER_API_KEY` (was
`…_APIKEY`).

Every integration config key is lowerCamel. The kebab-case credential keys are
renamed: `bike-sharing` `dbBikeClientId` and `dbBikeApiKey`; `ride-gofs`
`caTaxiMontrealApiKey` and `gofsCustom1ApiKey` to `gofsCustom3ApiKey`
(variables `INTEGRATION_RIDE_GOFS_GOFS_CUSTOM1_API_KEY` and so on);
`ride-partner` `yangoClientId`, `yangoApiKey`, `karhooClientId` and
`karhooClientSecret`; `scooter-sharing` `deNwMobidromScooterClientId` and
`deNwMobidromScooterClientSecret`; `routing-valhalla` `bidirectionalAlternates`.

Every service config key is UPPER_SNAKE and names its `SERVICE_<ID>_<KEY>`
variable as is. Valhalla's keys are `SERVE_TILES`, `BUILD_ELEVATION`,
`BUILD_ADMINS`, `BUILD_TIME_ZONES` and `USE_TILES_IGNORE_PBF`.

Integration and service manifests refuse config keys in another style.

## Who is affected

Operators who set integration settings in `infra/docker/.env`, and authors of
community integration or service manifests.

## Required action

Rename the variables in `infra/docker/.env` as above; the documentation and
`.env.example` list the new names. Settings saved in the admin panel are kept
under the new keys only on a new installation.
