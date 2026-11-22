---
impacts: [security, operator-action]
---

## What changes

PostGIS, `pg_trgm`, `fuzzystrmatch` and `btree_gist` are installed into an
`extensions` schema that only the PostgreSQL superuser can create objects in,
instead of the `public` schema the API's role owns. The API's database role
searches `public, extensions`; data-manager's role and Martin's login search
only `extensions`. A compromised API can therefore no longer put a function in
`public` that runs with data-manager's, the tile server's or OpenConditions'
rights in place of a PostGIS function. The PostGIS image's topology and TIGER
geocoder extensions and its `template_postgis` database are no longer created.

PostGIS no longer grants the tile server's function role read access to every
OpenConditions table on each start. OpenConditions' migration grants it the
four tables and three functions its traffic tiles read, so the tile role can
no longer read OpenConditions' OAuth tokens, private keys or crowd reports, and
traffic tiles work without a PostGIS restart after OpenConditions migrates.

## Who is affected

New installations, and operators who install OpenConditions or another
community service that uses PostGIS. No released installation exists.

## Required action

Install fresh with an empty database volume: PostGIS cannot move to another
schema once installed. When you create a database role for a community
service, give it a search path of its own schemas and `extensions`, for
OpenConditions `ALTER ROLE … SET search_path = conditions, extensions`, before
the service first starts. Create both OpenConditions roles before its ingest
service first starts, and grant nothing in `conditions` yourself; its
migration grants each role what it uses. In your own superuser `psql` sessions, run
`SET search_path = pg_catalog, extensions` before calling a PostGIS function.
