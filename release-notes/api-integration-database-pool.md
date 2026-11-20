---
impacts: [operator-action]
---

## What changes

The API runs the database queries of search and place integrations (POI search,
notable places, aliases, Overture) on a separate connection pool named
`openmapx-api-integrations`. It holds at most 4 connections and ends a query
after 5 seconds; such a query then leaves that provider's results out instead of
failing the request. The main API pool keeps at most 10 connections, now closes
connections idle for a minute, and still has no statement timeout.

## Who is affected

Installations that limit PostgreSQL connections closely, or run several API
replicas against one database.

## Required action

Each API replica now opens up to 14 database connections instead of 10. Make
sure PostgreSQL's `max_connections` covers every replica plus the data manager
and other clients.
