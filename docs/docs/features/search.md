---
title: Search & autocomplete
description: Find places by name or address, get suggestions as you type, search points of interest, and turn coordinates back into addresses.
sidebar_position: 1
---

# Search & autocomplete

Search is how people get to a place. Type into the bar at the top of the map
and OpenMapX finds cities, streets, addresses, businesses, transit stops, and
landmarks — suggesting matches as you type and dropping a pin on the one you
pick. The same machinery runs in reverse, turning a point you tapped on the map
back into a readable address.

None of this depends on a single proprietary search box. The search experience
sits on top of a **geocoding orchestrator** that you point at one or more
geocoders — each one a plugin you can swap, self-host, or chain behind another.

## What you can search for

The search bar accepts far more than a place name, and it understands several of
the things you might type without a separate mode:

| You type…                          | You get…                                                       |
| ---------------------------------- | -------------------------------------------------------------- |
| A place or business name           | Matching addresses, POIs, streets, and regions                 |
| A street address                   | The pinpointed location, with the formatted address            |
| A category word ("coffee", "fuel") | A category search that plots every match in the current view   |
| A plain-language question          | A parsed intent that runs the matching category, filter, area, and hours search |
| A transit stop name                | The stop, with its line modes, opening straight to the stop    |
| An airport name or IATA/ICAO code  | The airport, opening its detail panel (runways, frequencies)   |
| Latitude/longitude or a Plus Code  | A pin at those exact coordinates                               |
| "Home" / "Work" or a saved label   | Your own labeled places, surfaced near the top                 |

Suggestions arrive **as you type**: the bar debounces your input, fetches
autocomplete results, and ranks them locally so the closest match floats to the
top. Pressing Enter on a precise match (an address, street, or region) flies
straight there; a broader, name-only query opens a results panel scoped to what
you can currently see on the map. Coordinates and Plus Codes are detected client
side and resolved without a round trip to a geocoder at all.

### Voice search

On browsers that expose the Web Speech API, a microphone button lets you speak
the same queries you can type. OpenMapX asks for microphone permission, uses a
region-qualified locale, places interim recognition text in the search box, and
submits the final transcript through the normal search path. The button is
hidden when speech recognition is unsupported, and permission or recognition
errors stay visible in the search UI.

Speech recognition is a browser capability, not an OpenMapX backend provider.
Depending on the browser and operating system, audio may be processed by the
browser vendor's speech service; consult that browser's privacy documentation.

### Category and POI search

Beyond named places, you can search by *category* — "restaurants," "pharmacies,"
"EV charging." Category search asks a separate POI-search service for everything
of that kind inside the current map viewport and plots the lot. It is backed by
`poi-overpass`, which queries OpenStreetMap through Overpass. Deployments can
also enable [Overture Places](./overture-places.md): its locally ingested records
are fused with OSM and Overture-only places fill coverage gaps. The orchestrator
shrinks the search area automatically if Overpass times out. Free-text searches scoped to the visible map
("`bakery near me`") run through the same path. Category results carry opening
hours and other place metadata, which feeds the [place panel](./places.md).
Attribution identifies the sources that actually contributed returned records;
if one provider fails while another succeeds, the result is marked partial.

For queries that read like a question rather than a place name — "quiet vegan
cafe with wifi open now" — OpenMapX can parse the sentence into a structured
search and run it for you. That's a feature of its own, local-first and with an
optional cloud assist: see
[Natural-language search](./natural-language-search.md).

### Reverse geocoding

Reverse geocoding is forward geocoding run backwards: give it a latitude and
longitude and it returns the address and city at that point. OpenMapX uses it
whenever a location starts as coordinates rather than text — a long-press on the
map, a dropped pin, your current position — so those places still get a proper
name and address. A coarser variant resolves a point down to just its country
code, which region-aware features use to decide what's available where you are.

## How it works

Every search request the app makes goes to the **geocoding** integration, which
exposes the search routes (`/geocode`, `/autocomplete`, `/geocode/reverse`) and
owns the logic around them — query normalization, caching, and result shaping.
What it does *not* do is talk to a geocoder directly. That job belongs to the
provider integrations it orchestrates.

### A configurable provider chain

The orchestrator is configured with an **ordered list of providers** — a
fallback chain. For each request it tries the first provider; if that one errors
or returns nothing, it moves on to the next, and so on down the list. The first
provider to return results wins, and the response records which one answered (so
the right attribution is shown beneath the suggestions). A single-provider
setup is just a chain of length one.

Each provider in the chain is its own integration, wrapping one geocoding engine:

| Provider     | Integration          | Backed by                                                    |
| ------------ | -------------------- | ------------------------------------------------------------ |
| `nominatim`  | `geocoding-nominatim`| Nominatim — self-hosted from OSM, or the public OSM instance |
| `photon`     | `geocoding-photon`   | Photon — self-hosted, or the public Komoot instance          |
| `pelias`     | `geocoding-pelias`   | Pelias — self-hosted (Elasticsearch-backed)                  |
| `maptiler`   | `geocoding-maptiler` | MapTiler Cloud (hosted; needs an API key)                    |
| `motis`      | `geocoding-motis`    | A self-hosted MOTIS server, with Transitous as cloud fallback |
| `transitous` | `geocoding-motis`    | The public Transitous geocoder (an alias of the MOTIS provider) |
| `db-ris`     | `geocoding-db-ris`   | Deutsche Bahn RIS Stations (German rail stops; needs credentials) |
| `entur`      | `geocoding-entur`    | The Entur geocoder (Norwegian transit and places)            |

Mixing engines is the point. You might run Photon for fast self-hosted
autocomplete and fall back to MapTiler for global coverage, or put a
transit-specialist geocoder like `motis` or `db-ris` first so station searches
resolve precisely before a general geocoder gets a turn.

### Normalized results and query expansion

Whichever engine answers, the orchestrator hands the app a **uniform result
shape** — a label, coordinates, a type (`address`, `poi`, `street`, `region`,
and so on), and a confidence score. Your search code never has to care which
engine produced a match.

Two touches improve recall along the way. Queries are **expanded for transit
abbreviations** in several languages before they're sent on, so "Aachen Hbf"
and "Aachen Hauptbahnhof" find the same station regardless of which form you
type (likewise *Bf* / *Bahnhof*, *Stn* / *Station*, *St-* / *Saint-*). And
results are **cached** at two layers — a small in-memory cache for hot
autocomplete prefixes plus a shared Valkey (Redis-compatible) cache — keyed on the normalized query
so common searches return without touching an upstream engine. When an upstream
is briefly unreachable, the app serves slightly stale cached results rather than
failing the search.

For the bigger picture of how integrations, services, and the API server fit
together, see [How it works](../overview/how-it-works.md).

## Choosing and configuring providers

Which geocoders you run, and in what order, is a matter of which provider
integrations are enabled and how the orchestrator is configured. Both are
managed from the admin panel rather than in code.

- **Enable the engines you want.** Self-hosted geocoders (Nominatim, Photon,
  Pelias, MOTIS) run as backend [services](../install/managing-services.md);
  enable the service and its companion `geocoding-*` integration. Hosted
  providers (MapTiler, Entur, DB RIS) need no service — just the integration and
  its credentials.
- **Set the provider order.** The geocoding integration takes a comma-separated
  **provider order** — the fallback chain, for example `photon,maptiler`. The
  default is `maptiler`. Set it in the integration's config in the admin panel.
- **Supply any keys.** Providers that call a hosted API (MapTiler's key, DB RIS
  credentials) read their secrets from the same per-integration config. Each
  provider integration also points its underlying engine at a self-hosted
  endpoint or a sensible public default.

Every upstream call is proxied through your own server, so the geocoder sees
your server's address rather than your users'. For where configuration values
live and how the admin panel relates to environment variables, see
[Configuration](../install/configuration.md).

:::note[A geocoder isn't required to run the map]
Search degrades gracefully: with no geocoder configured, the map, coordinate
input, and Plus Codes still work — you simply won't get name or address
suggestions until a provider is enabled.
:::

## Related features

- **[Places](./places.md)** — what happens after you pick a search result: the
  place detail panel, POI enrichment, and category search.
- **[Directions](./directions.md)** — search powers the from/to fields when you
  plan a route.
- **[Public transit](./public-transit.md)** — transit-specialist geocoders and
  stop search feed journey planning.
