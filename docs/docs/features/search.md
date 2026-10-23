---
title: Search and autocomplete
description: Find places, addresses, categories, transit stops, and coordinates.
sidebar_position: 1
---

# Search and autocomplete {/* #search--autocomplete */}

Type in the search bar above the map, then select a suggestion to open its
[place panel](./places.md). Suggestions depend on the instance's enabled
geocoders, specialist catalogs, and local search data. An address or business
missing from those sources may not appear.

## What you can search for

| Input                                              | Result                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| Place, business, street, or address                | Matching suggestions with names and location context             |
| Category, such as "coffee" or "pharmacy"           | A search for matching places in the visible map area             |
| Sentence, such as "vegan cafes with wifi open now" | A natural-language search suggestion when enabled and recognized |
| Transit stop name or published code                | A stop or station from an enabled source                         |
| Airport name, IATA code, or ICAO code              | An airport and its available details                             |
| Supported alias or acronym                         | The canonical name, with the matched alias or code               |
| Latitude/longitude or Plus Code                    | A pin at the decoded coordinates                                 |
| Home, Work, or a saved label                       | Your labeled places when available                               |

Choose a dropdown row when you mean a particular place. Pressing Enter can open
a clear place match, start a category or visible-area search, or wait for you to
resolve an ambiguous name. A chain name can return its branches around the map
instead of opening one distant branch. Name and address words can help identify
a remote place; incomplete address words are weaker evidence.

Coordinates and Plus Codes are decoded in the browser. Opening the resulting
pin can still request an address and other place information from the server.

### Keeping distinct places in the list

Businesses with the same name can remain separate choices. Check their address
and location before selecting one. OpenMapX combines records with a shared
identity and uses conservative address matching for other duplicates; it can
leave two rows when the sources do not establish that they describe one place.
Stations, entrances, and similarly named squares can also remain separate.

### Famous places far away

An optional Wikidata-derived notable-place index helps find landmarks and cities
far from the current map, including supported translated names and some typing
errors. Coverage depends on the installed index. Operators prepare it under
[Notable places for search](../install/configuration.md#notable-places-for-search).

### Codes, aliases, and acronyms

Airport codes come from OurAirports. Enabled transit sources contribute the stop
codes they expose. Entur and DB RIS can add regional suggestions within their
coverage. A locally prepared OSM index adds aliases, references, and selected
institution or facility acronyms for its installed region.

Exact authoritative codes rank ahead of weaker alias and acronym matches.
Generated acronyms require an exact match; they are not a global codes registry.
The canonical name remains visible so you can check what a code resolved to.

### Voice search

Use the microphone button where the browser supports speech recognition. Grant
microphone permission, speak the query, and OpenMapX submits the final transcript
through ordinary search. The button is hidden on unsupported browsers.

Audio processing belongs to the browser and operating system. It may use the
browser vendor's speech service. Check that browser's privacy settings before
speaking sensitive information.

### Category and POI search

Choose a category or submit a category word to show matching points of interest
in the visible area. After panning, use **Search this area** to search the new
view. Results are bounded by provider limits, source coverage, and filters;
the markers do not represent every matching business.

The standard POI provider queries OpenStreetMap through Overpass. Optional
[Overture Places](./overture-places.md) can add locally hosted records. A slow
Overpass query can be retried over a smaller area. If one source fails while
another supplies results, the response can be partial. Check the result credits.

For category, attribute, and hours queries written as sentences, see
[Natural-language search](./natural-language-search.md).

### Reverse geocoding

A dropped pin or your current position can be resolved to an address through the
configured geocoder. The returned address describes available source data; it
need not identify a particular entrance, building tenant, or exact house number.

## How it works

Name and address lookup uses a configured geocoder chain. Specialist catalogs
add suggestions separately, and the browser ranks the combined choices using
name matches, distance, and available importance information. The dropdown order
can differ from a geocoder's original order. Ranking cannot recover a place
that no source returned.

### A configurable provider chain

The first configured geocoder to return a nonempty result supplies the response.
An error or empty result can advance to the next configured provider. This chain
does not combine every geocoder's full result set.

| Provider                  | Typical use                                                         |
| ------------------------- | ------------------------------------------------------------------- |
| Nominatim, Photon, Pelias | General geocoding with a local service or supported hosted endpoint |
| MapTiler                  | Hosted general geocoding; requires a key                            |
| MOTIS / Transitous        | Transit-oriented geocoding, with local or hosted operation          |
| DB RIS                    | German railway stations; requires credentials                       |
| Entur                     | Norwegian places and transit                                        |

### Normalized results and query expansion

OpenMapX normalizes provider results and expands supported station abbreviations,
such as Hbf and Hauptbahnhof. Matching names and settlement context help rank
station queries. Cached answers reduce repeat provider requests and can retain
older results during a temporary source failure.

## Choosing and configuring providers

Operators configure the `geocoding` integration's **Provider order** and each
provider's endpoint and credentials under **Admin → Integrations**. The shipped
order is `maptiler`; a working MapTiler credential or another configured chain
is needed for general name and address lookup.

For installation, defaults, public endpoint limits, and local services, use the
[geocoder guide](../guides/geocoders.md). Search requests pass through OpenMapX's
server, but a configured hosted source still receives the query and location
context from that server.

If name search is unavailable, coordinate and Plus Code input can still place a
pin. Check spelling, move the map closer, or choose a category for a broader
search. Operators should check enabled providers, credentials, source policy,
and service health when all lookups fail.

## Related features

- [Places](./places.md): inspect a result and its sources.
- [Saved places](./saved-places.md): lists and labels.
- [Directions](./directions.md): search for route endpoints.
- [Public transit](./public-transit.md): stops, departures, and journeys.
