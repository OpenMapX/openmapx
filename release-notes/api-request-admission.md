---
impacts: [security, operator-action]
---

## What changes

The API's rate limits now classify each request by the route it matched, so a
percent-encoded spelling of a path sent straight to the API is limited like the
plain one. A request that matches no route has its own small budget instead of
none. Limits count every address in one IPv6 /64 as one client, and refused
requests are no longer stored as error rows in the application log.

Route optimization, EV route plans, reverse geocoding, transit journey planning
and hotel offers now use the tighter `expensive` limit. Directions use a new
`routing` limit sized for navigation. Autocomplete and forward
geocoding use a new `typeahead` limit sized for typing. The TomTom traffic proxy
shares a daily budget of 50,000 tiles across all clients. The MapTiler proxy can
be given one with `MAPTILER_DAILY_REQUEST_LIMIT`; it has none unless you set it.
Each routing engine has a shared budget of 3,000 calls a minute and 500,000 a
day.

Natural-language search counts its hourly limit per client network, ignores the
old `ip` query parameter, rejects queries over 500 characters and gives cloud
providers a daily budget with a per-caller share. In the default `consent`
privacy mode, cloud providers now run only for signed-in users who opted in;
anonymous searches use local providers.

## Who is affected

Installations whose routing engines serve more than 3,000 calls a minute.
Installations with a cloud natural-language provider in `consent` mode, whose
anonymous users lose cloud parsing.

While Valkey is configured but unreachable, the TomTom proxy answers 503,
routing engines and any configured MapTiler budget are counted in each API
process instead, and natural-language search uses only its keyword parser.

## Required action

To cap what visitors can spend on your MapTiler key, set
`MAPTILER_DAILY_REQUEST_LIMIT`, sized for every visitor's basemap tiles and
glyphs. Raise `TOMTOM_TRAFFIC_DAILY_REQUEST_LIMIT`, the routing integration's
`providerRequestsPerMinute` and `providerRequestsPerDay`, or search-nlp's
`cloudRequestsPerDay` and `cloudRequestsPerClientPerHour` if your traffic needs
more. To keep cloud parsing for anonymous users, set search-nlp's `privacyMode`
to `open`. Other installations need no action.
