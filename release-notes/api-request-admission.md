---
impacts: [security, operator-action]
---

## What changes

The API's rate limits now classify each request by the route it matched, so a
percent-encoded spelling of a path sent straight to the API is limited like the
plain one. A request that matches no route has its own small budget instead of
none. Limits count every address in one IPv6 /64 as one client, and refused
requests are no longer stored as error rows in the application log.

Routing, route optimization, reverse geocoding, transit journey planning and
hotel offers now use the tighter `expensive` limit. Autocomplete and forward
geocoding use a new `typeahead` limit sized for typing. The TomTom traffic and
MapTiler proxies share a daily request budget across all clients, by default
50,000 TomTom tiles and 3,300 MapTiler assets a day, and each routing engine has
a shared budget of 600 calls a minute and 100,000 a day.

Natural-language search counts its hourly limit per client network, ignores the
old `ip` query parameter, rejects queries over 500 characters and gives cloud
providers a daily budget with a per-caller share. In the default `consent`
privacy mode, cloud providers now run only for signed-in users who opted in;
anonymous searches use local providers.

## Who is affected

Installations that use MapTiler for the hosted basemap or MapTiler layers on a
paid plan, where 3,300 requests a day may be too few. Installations whose
routing engines serve more than 600 calls a minute. Installations with a cloud
natural-language provider in `consent` mode, whose anonymous users lose cloud
parsing.

While Valkey is configured but unreachable, the TomTom and MapTiler proxies and
routing engine calls answer 503, and natural-language search uses only its
keyword parser.

## Required action

On a paid MapTiler plan, set `MAPTILER_DAILY_REQUEST_LIMIT` to your plan's daily
share. Raise `TOMTOM_TRAFFIC_DAILY_REQUEST_LIMIT`, the routing integration's
`providerRequestsPerMinute` and `providerRequestsPerDay`, or search-nlp's
`cloudRequestsPerDay` and `cloudRequestsPerClientPerHour` if your traffic needs
more. To keep cloud parsing for anonymous users, set search-nlp's `privacyMode`
to `open`. Other installations need no action.
