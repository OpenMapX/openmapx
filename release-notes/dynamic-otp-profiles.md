---
impacts: [breaking, operator-action]
---

## What changes

Dynamic OTP stops, name search and departures now use generated, validated GTFS
or Transmodel clients for explicitly reviewed provider endpoints. Stadtnavi,
Peatus and Torino use their complete current GraphQL URLs. Trufi uses Transmodel.
Missing, malformed, denied or unavailable responses are failures, not successful
empty results. Provider configuration and attribution belong to the setup that
acquired them. Duplicate dynamic Entur is suppressed in favor of the dedicated
integration. Unregistered OTP planning, arrivals and alert helpers were removed;
no additional capabilities are advertised. HAFAS acquisition is unchanged except
that setup now supplies its full catalog entry.

## Who is affected

Operators using the Dynamic Transit Registry integration. Unreviewed or changed
OTP catalog endpoints are rejected. Coordinates, stop IDs, names and requested
windows must be valid; departure windows are integer minutes from 1 to 1440,
radii integer metres from 1 to 50000 and search limits integers from 1 to 100.

## Required action

Configure the new secret `digitransitApiKey` for Finnish Digitransit providers,
using a subscription to the required Routing v2 GTFS APIs. The key is sent only
as `digitransit-subscription-key` to the four exact reviewed endpoints; catalog
credentials are ignored. Authenticated Digitransit acceptance remains unverified
without an operator key. Public OTP requests require a working shared upstream
admission store for provider-wide Retry-After cooldowns; store failure fails closed.
No new result cache, migration or compatibility mode is provided. Self-hosted
OTP remains independent of this shared admission store.
