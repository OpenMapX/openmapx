---
impacts: [breaking, operator-action]
---

## What changes

Installed integrations can ship backend code. An integration artifact may carry a
prebuilt `dist/backend/index.mjs` (declared as `backend.entry`), numbered
`migrations/NNNN_name.sql` files (declared with `database.migrations: true`) and
`assets/`. Frontend code, undeclared bundles or migrations, native add-ons and a
`node_modules/` directory are refused. The API verifies the bundle against the
SHA-256 the operations agent recorded, copies it into a cache keyed by that hash
(`OPENMAPX_INTEGRATION_CODE_CACHE_DIR`, default `<tmp>/openmapx-integration-code`,
recreated after every start) and imports it into its own process. There it has
the same access as a built-in integration to the instance, its credentials and its
users' data. Before the import, the API refuses a bundle that imports anything but
`@openmapx/integration-sdk`, `zod` and Node built-ins; that check gives a packaging
mistake a clear error and is not a security boundary. Install only integrations
you trust; a verified catalog entry means a maintainer reviewed that version and
the host checks its pinned bytes.

An installed integration whose import or `setup` fails, or whose import and
`setup` together take longer than 60 seconds, is left out: what it registered is
undone, the rest keep loading, and the admin integrations list shows **Failed to
load** with the step (migrate, import, setup or deadline) and the error. A
failing built-in still aborts a reload. An install or update job whose
integration fails to load ends failed with "Integration <id> failed to load:
<message>" and rolls back. Every provider is checked when it is registered
(required members, the domain contract, one provider per key per integration and
domain), so a malformed provider fails `setup` instead of a later request. Calls
into integration code run under the integration's name in the logs and stop at a
deadline per domain (`ProviderTimeoutError`); calls over five seconds are logged.
After a reload retires an integration's previous generation, or after it is left
out, late calls it makes to its context are ignored with one warning per method.
Removing, disabling or updating an installed integration stops what it registered
at once; its code stays loaded in the API process until the next restart.

An integration that requires PostGIS or declares `database.migrations: true` gets
`ctx.db` with `transaction(fn, { timeoutMs })` besides `execute`. Transactions run
on a new API pool, `openmapx-api-extensions`, of at most 2 connections; each ends
with `ProviderTimeoutError` and rolls back when the wait for a connection, the
transaction, one of its statements or a pause between them outlasts its timeout
(default 30 seconds, at most 15 minutes), unless its callback has finished and the
COMMIT is already running. An integration runs one transaction at a time and
cannot nest them. For an integration that ships migrations, the search path is its
schema `ext_<id>` (hyphens as underscores), then `extensions`, where PostGIS lives;
`public` is not on it, so platform tables are named with their schema. Its
`ctx.db` refuses to run while that schema is missing and once the integration's
data was removed. Database calls an unloaded integration still makes run with one
warning per method. When a reload retires an installed integration or it is left
out, the API waits at most 10 seconds for each of its shutdown handlers; when the
API stops, the shutdown handlers of all installed integrations share 5 seconds in
total.

The API applies an integration's migrations at every start and reload, before it
imports the integration's code and outside the 60-second load budget, with the
API's database role, which can read and change every platform table; install
only integrations you trust. The files apply in order into the schema `ext_<id>`,
each once, all files of one start in one transaction, and each is recorded with
its SHA-256. A file may not change after it was applied, a new file may not be
numbered below an applied one, and a file may not contain transaction control
(`COMMIT`, `ROLLBACK`, `BEGIN`, `SAVEPOINT`) or statements that cannot run inside
a transaction, such as `CREATE INDEX CONCURRENTLY` or `VACUUM`, nor
`COPY ... FROM STDIN`. Each file runs with the search path set to the schema,
then `extensions`, and the settings it changes end with it; deferred constraints
are checked at the end of each file. After each file the API refuses the
migration unless every foreign key from the schema to a table outside it, and
every key to a table of the schema that such a cascade deletes rows from, is
`ON DELETE CASCADE`; `SET NULL`, `SET DEFAULT`, `NO ACTION` and `RESTRICT` are
refused there. An integration that needs another behaviour stores the id
without a foreign key and erases the rows through its subject-data handler.
Keys on or to a partitioned table are judged for each partition. So, while the
schema's keys change only through the integration's own migration files, no
foreign key of the schema can make deleting a row outside it, for example an
account, fail. The check judges foreign keys only: a trigger, rule or check
constraint of the integration can still make a deletion fail, and a file must
not create objects outside its schema, because such objects escape the check
and are not removed with the integration's data. A key that another
integration's migration adds to this schema's tables, or one created through
`ctx.db` at run time, is not judged either. Migrations wait at most 2
minutes for a lock and run at most 30 minutes in all; both limits are also set
on the database session, so PostgreSQL ends a migration whose API process went
away, unless a file turned the session's time limit off itself. A stop request,
during start-up or while a reload is migrating, cancels running migrations, and
no further integration's migrations start. While
migrations run at start-up the API does not yet
serve requests, and a long migration can make the container unhealthy; restarting
it then starts the migration over. When a file fails or a limit is reached,
everything is rolled back and the integration is left out with the step
**migrate**; fix the file and install it again. When an integration was rolled
back to a version that ships fewer migrations than were applied, it still loads,
and the admin attention list warns that it "runs against a newer database schema"
(`integration-schema-ahead:<id>`). Removing an integration's data drops its schema
and its bookkeeping rows, after waiting for a migration of it that is running.

The admin integration API drops `blockedCode` and gains `loadState`, `loadError`,
`loadErrorPhase` and a required `status` (`healthy`, `unhealthy`, `unconfigured`,
`disabled`, `failed`); `GET /api/admin/provider-order` is new. Older API clients
that parse these objects strictly reject the new fields. `enabled` is the run-time
flag: it is `false` for an integration whose code failed to load; use `status`.
The admin overview counts such an integration as enabled and unhealthy, as the
integrations list does. Installed manifests may use `${endpoint:<id>}` in a health
check's URL template, as built-in ones do.

Operators can order providers per domain: routing, geocoding, weather, POI search,
photos, reviews, road conditions, transit, live transit, fuel, parking, EV charging,
webcams, message signs, road weather, road maintenance and border crossings each
gain a `providerOrder` setting (the admin **Provider order** control, or
`INTEGRATION_<ID>_PROVIDER_ORDER`, which overrides it and makes the control
read-only). Orchestrators no longer select providers by built-in provider ids:

- Geocoding: the `provider` setting and `INTEGRATION_GEOCODING_PROVIDER` (short
  names such as `photon,maptiler`) are replaced by `providerOrder` and
  `INTEGRATION_GEOCODING_PROVIDER_ORDER`, a list of integration ids, default
  `geocoding-maptiler`. The list is a selection: only listed geocoders are asked,
  including installed ones, and short names are skipped with a warning.
  Natural-language search resolves places with the first selected geocoder.
- Isochrones: `ISOCHRONE_PROVIDER` is removed. Street isochrones come from the first
  routing engine in order that offers them (built in: `routing-valhalla`, whose
  `endpoint` now also applies to isochrones); without one, `/api/isochrone`
  answers 503. Against Stadia Maps, isochrones use
  `INTEGRATION_ROUTING_VALHALLA_API_KEY`; `VALHALLA_API_KEY` now serves elevation
  and bus road-snapping only. The travel-time overlay's `apiKey` setting and
  `INTEGRATION_OVERLAY_TOOL_TRAVEL_TIME_API_KEY` are removed; its health follows
  whether an isochrone-capable engine is loaded.
- Routing engines follow `providerOrder` (default BRouter, Valhalla, OSRM); a
  provider's priority only orders unlisted engines. Failed and empty route answers
  offer the other engines that can plan the same trip.
- Weather follows `providerOrder` (default Bright Sky, OpenWeatherMap, MET Norway,
  Open-Meteo) and skips integrations disallowed by the data-use policy.
- POI fusion uses the first provider that declares `fusionRole: "base"` (built in:
  Overpass) instead of the provider id `overpass`; Overture declares `augment`.
- Transit keeps its roles first, then the operator's order, then priority. Prefix
  lookups, lookups by id and stop search without a map area now follow this order
  instead of priority alone. Refresh tokens are issued for any planner that
  declares refresh and are bound to the planner that answered; the built-in MOTIS
  planner now returns a next token after each refresh, so navigating clients keep
  refreshing a MOTIS itinerary for the whole trip.
- Photo providers of an integration the data-use policy disallows are no longer
  queried for place photos, hero photos or card photos.
- `/autocomplete` answers `[]` instead of 500 when no selected geocoder is loaded.
- Review submissions without a capable provider fail with "No review provider
  supports submissions" or "No review provider supports image uploads".
- The admin GTFS catalogue's `source` is a bounded string instead of an enum; the
  data-manager applied-traffic snapshot's `providerId` is an open string. The
  generated models `GetApiDataManagerTransitCatalog200SourcesItemSource` and
  `GetAppliedTrafficConditions200ProviderId` are removed.

Routing, geocoding, weather, POI, photo and isochrone caches start cold.

## Who is affected

Operators who set `INTEGRATION_GEOCODING_PROVIDER`, `ISOCHRONE_PROVIDER`,
`INTEGRATION_OVERLAY_TOOL_TRAVEL_TIME_API_KEY`, or only `VALHALLA_API_KEY` for
Stadia isochrones; development databases that stored the geocoding `provider` or
the travel-time overlay `apiKey` through the admin interface; clients of the admin
integration API; operators deciding which community integrations to install;
authors of integration artifacts and of scripts that match the old
"declarative-only" refusal messages.

Extension authors get two new private packages, `@openmapx/integration-sdk` (what
a backend bundle may import, including a testing context that runs the host's
registration checks) and `@openmapx/provider-kit` (shared provider helpers moved
out of individual integrations; the old module paths are gone). Neither is
published yet.

## Required action

Replace `INTEGRATION_GEOCODING_PROVIDER=photon,maptiler` with
`INTEGRATION_GEOCODING_PROVIDER_ORDER=geocoding-photon,geocoding-maptiler` (each old
name becomes `geocoding-<name>`), and list every geocoder that should be asked. With
the hosted Stadia Valhalla, set `INTEGRATION_ROUTING_VALHALLA_API_KEY` (keep
`VALHALLA_API_KEY` for elevation). Remove `ISOCHRONE_PROVIDER` and
`INTEGRATION_OVERLAY_TOOL_TRAVEL_TIME_API_KEY`. A database that stored the removed
geocoding `provider` or overlay `apiKey` keys refuses later configuration changes and
must be recreated; there is no migration, and no released version precedes this
change, so new installations need no action. Review the backend code of any
community integration before installing it. Each API replica now opens up to 16
database connections instead of 14; make sure PostgreSQL's `max_connections`
covers every replica plus the data manager and other clients.
