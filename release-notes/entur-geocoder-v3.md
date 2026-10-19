---
impacts: [breaking, operator-action]
---

## What changes

Entur geocoding and Entur transit stop search use the native Geocoder v3
contract. The shared client implements autocomplete, reverse geocoding and exact
place lookup. Endpoint
settings are unversioned service bases; the client appends `/v3` operation paths.
Country settings accept one lowercase ISO 3166-1 alpha-2 code: omitted means
`no`, and an exact empty string means unscoped. `multiModal` accepts `parent`,
`child` or `all`. Native place IDs and supplier-specific attribution are retained.
Invalid configuration, denied sources and failed provider requests produce
errors rather than successful empty results.

## Who is affected

Operators using `geocoding-entur` or `transit-entur`, particularly installations
with custom endpoint or country settings, and consumers of Entur search and
place IDs. Journey Planner, realtime vehicles and NSR read API behavior retain
their separate contracts.

## Required action

Before enabling these integrations after an application upgrade, review their
settings against the current contract: `endpoint` for geocoding and
`geocoderEndpoint` for transit must identify the unversioned service base
(default `https://api.entur.io/geocoder`); `boundaryCountry` must be a lowercase
two-letter country or an exact empty string. Review the declared API and supplier
source permissions and attribution terms. Geocoding may use NSR, OpenStreetMap,
Kartverket and Entur custom POI suppliers; transit stop search declares NSR only.

Retain full native IDs for exact lookup and handle typed provider failures.
There is no automatic configuration or ID conversion. This change performs no
cache purge, rewrite or namespace/version change, and requires no cache operation.
