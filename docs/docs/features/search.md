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

| You type…                          | You get…                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| A place or business name           | Matching addresses, POIs, streets, and regions                                  |
| A street address                   | The pinpointed location, with the formatted address                             |
| A category word ("coffee", "fuel") | A category search that plots every match in the current view                    |
| A plain-language question          | A parsed intent that runs the matching category, filter, area, and hours search |
| A transit stop name                | The stop, with its line modes, opening straight to the stop                     |
| An airport name or IATA/ICAO code  | The airport, opening its detail panel (runways, frequencies)                    |
| A public place or stop code        | The matching airport, station, or coded OSM feature                             |
| An explicit alias or acronym       | The canonical place name, with the matched value shown beside it                |
| Latitude/longitude or a Plus Code  | A pin at those exact coordinates                                                |
| "Home" / "Work" or a saved label   | Your own labeled places, surfaced near the top                                  |

Suggestions arrive **as you type**: the bar debounces your input, fetches
autocomplete results, and ranks them locally by how well the name matches, how
near the place is, and how well known it is. Pressing Enter opens a place only
when the text plainly names it: "paris" opens Paris and "louvre" the museum in
Paris, while a word that names a kind of place nearby ("vegan", "döner") or a
chain's branches ("aldi") search what you can currently see on the map. When
several equally known places far away share the name ("springfield"), the list
stays open with the first one highlighted, and a second Enter takes it.

A complete name followed by complete normalized address words (for example,
"MediaMarkt Rijswijk") supplies explicit location evidence, even far from the
map. A partial address word remains a weaker autocomplete match: "Alexa" in a
street named "Alexander" does not establish exact remote business intent.
Ordinary name prefixes, explicit aliases and official codes keep their existing
confidence. When the returned rows do not confidently name the query, plain
Enter follows the existing natural-language or visible-area search path; an
explicit dropdown choice still opens that row. This can make the dropdown order
differ from the server's candidate order without changing candidate retrieval.

Coordinates and Plus Codes are detected client side and resolved without a
round trip to a geocoder at all.

### Keeping distinct places in the list

Nearby businesses with the same name remain separate choices, with their own
IDs, addresses and coordinates. Name and distance alone do not establish
business identity, including for co-located tenants or POIs without a category.
An identical result ID or a shared non-empty external identity still joins
records for the same entity, even when providers report different addresses.

Without shared identity, ordinary POIs merge only when their normalized names
match, they are less than 1,000 metres apart, and different source-record
namespaces corroborate the same concrete address. Address comparison removes a
repeated business name and normalizes spelling such as `Friedrichstr.` /
`Friedrichstraße`, while retaining unit/floor and locality context. Missing,
city-only or postcode-only context is insufficient: the street component must
contain a house number and a recognized street term, such as `Street`, `Road`,
`Rue` or `-straße`. Conflicting Wikidata items
or reported categories prevent this heuristic merge. Different provider IDs or
OSM node/way IDs alone do not prove different real-world entities; manifest
`sourceIds` describe attribution, not place identity.

This fallback is deliberately conservative, not an international address
parser: incomplete or differently formatted addresses and multiple records in
one source may remain as duplicate choices until a shared identity is supplied.
Stations and entrances retain their existing name/distance reconciliation, and
a station stays separate from its same-named square. Geographic features,
recognized landmarks and airport/notable-place catalogs retain spatial
reconciliation; a city from the notable-place index can still join its geocoder
record within 15 kilometres. A business category does not gain that exemption
from fame or a Wikidata item alone. Contradictory concrete addresses or Wikidata
entities also prevent landmark/catalog spatial merging; shared identity still
takes precedence. Commercial galleries require ordinary POI evidence.

### Famous places far away

A geocoder tells which of several namesakes is famous only if it has data on
fame, which the public Photon instance does not. OpenMapX keeps its own index
of places covered by many Wikipedias, built from Wikidata, so "colosseum" from
Berlin finds the one in Rome and "big ben" the tower in London, whichever
geocoder is configured. The index carries names in eight languages plus
Wikidata's language-independent label ("Colosseo", "Tour Eiffel"), and holds
the cities known worldwide as well, so "rom" or "münchen" typed with the app
in English opens Rome or Munich rather than a village of that name. A famous
name typed with a slip or two ("neuschwanstien", "eifel tower") still finds
the place, unless something nearby is really called that. It is maintained
by the data-manager; see
[Notable places for search](../install/configuration.md#notable-places-for-search).

### Codes, aliases, and acronyms

OpenMapX combines several suggestion catalogs without asking a general
geocoder to understand every specialist identifier. Exact authoritative codes
rank first, followed by explicit references and aliases, ordinary place names,
and finally conservatively generated acronyms. A suggestion always displays
the canonical place name; when the matched code or alias differs, a compact
badge shows what matched.

Coverage is intentionally tiered. OurAirports provides global airport codes.
Enabled transit providers contribute the public stop codes their source
actually exposes. Regional geocoders such as Entur (Norway) and DB RIS (German
railway stations) contribute their stop places when the map is centred inside
their coverage. OpenStreetMap aliases, references, and generated acronyms are
available inside the one PBF region for which the operator has built the local
search index. Generated acronyms require an exact match and are limited to
high-signal institutions and facilities; lowercase matches must also be nearby
or highly important. The first release does not include UN/LOCODE, fuzzy
acronym matching, or a global codes registry.

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

Beyond named places, you can search by _category_ — "restaurants," "pharmacies,"
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

Name and address requests go to the **geocoding** integration, which
exposes the search routes (`/geocode`, `/autocomplete`, `/geocode/reverse`) and
owns the logic around them — query normalization, caching, and result shaping.
What it does _not_ do is talk to a geocoder directly. That job belongs to the
provider integrations it orchestrates.

Specialist code and alias matches use the separate **search-suggestions**
orchestrator. It fans out concurrently to airport, transit, and local OSM-index
providers with independent timeouts, then ranks and deduplicates their results.
The web merges that response with geocoder results and keeps the existing
geocoder fallback chain unchanged. If a suggestion provider is unavailable,
normal geocoder, category, brand, preset, and saved-place suggestions continue
to work.

### A configurable provider chain

The orchestrator is configured with an **ordered list of providers** — a
fallback chain. For each request it tries the first provider; if that one errors
or returns nothing, it moves on to the next, and so on down the list. The first
provider to return results wins, and the response records which one answered (so
the right attribution is shown beneath the suggestions). A single-provider
setup is just a chain of length one.

Each provider in the chain is its own integration, wrapping one geocoding engine:

| Provider     | Integration           | Backed by                                                         |
| ------------ | --------------------- | ----------------------------------------------------------------- |
| `nominatim`  | `geocoding-nominatim` | Nominatim — self-hosted from OSM, or the public OSM instance      |
| `photon`     | `geocoding-photon`    | Photon — self-hosted, or the public Komoot instance               |
| `pelias`     | `geocoding-pelias`    | Pelias — self-hosted (Elasticsearch-backed)                       |
| `maptiler`   | `geocoding-maptiler`  | MapTiler Cloud (hosted; needs an API key)                         |
| `motis`      | `geocoding-motis`     | A self-hosted MOTIS server, with Transitous as cloud fallback     |
| `transitous` | `geocoding-motis`     | The public Transitous geocoder (an alias of the MOTIS provider)   |
| `db-ris`     | `geocoding-db-ris`    | Deutsche Bahn RIS Stations (German rail stops; needs credentials) |
| `entur`      | `geocoding-entur`     | The Entur geocoder (Norwegian transit and places)                 |

Mixing engines is the point. You might run Photon for fast self-hosted
autocomplete and fall back to MapTiler for global coverage, or put a
transit-specialist geocoder like `motis` or `db-ris` first so station searches
resolve precisely before a general geocoder gets a turn.

### Normalized results and query expansion

Whichever engine answers, the orchestrator hands the app a **uniform result
shape** — a label, coordinates, a type (`address`, `poi`, `street`, `region`,
and so on), and a confidence score. Your search code never has to care which
engine produced a match.

For station queries such as "Hauptbahnhof Neuss", forward geocoding ranks the
combined synonym results before caching them. Complete primary-name or matched
alias coverage, including the actual settlement when available, takes precedence
over provider order. Matching railway stations then rank ahead of individual
platforms and other POIs. Aliases discovered by later synonym responses are
retained when the same result ID is deduplicated. Street names and broad administrative regions cannot
establish a settlement match. Explicit taxi, parking, and numbered-address queries
retain provider ordering. Provider confidence remains metadata; MapTiler's value
is its original relevance, even when the final order changes.

The dropdown has its own ranking, including distance from the map center. It
recognizes railway station/halt categories from both MapTiler and OSM-style
providers. Its order can still differ from `/geocode`. Neither ranker can return
a station or square absent from the provider's candidates.

Two touches improve recall along the way. Queries are **expanded for transit
abbreviations** in several languages before they're sent on, so "Aachen Hbf"
and "Aachen Hauptbahnhof" find the same station regardless of which form you
type (likewise _Bf_ / _Bahnhof_, _Stn_ / _Station_, _St-_ / _Saint-_). And
results are **cached** at two layers — a small in-memory cache for hot
autocomplete prefixes plus a shared Valkey (Redis-compatible) cache — keyed on the normalized query
so common searches return without touching an upstream engine. When an upstream
is briefly unreachable, the app serves slightly stale cached results rather than
failing the search.

Equivalent station spellings use the same canonical upstream variant order as
well as the same cache key, so a cold cache populated with "Hbf" or
"Hauptbahnhof" produces the same answer. Forward answers use the `cache:geocode`
namespace with separate language and proximity slots and a 24-hour TTL.
Autocomplete category recognition happens in the client.

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

The OSM search snapshot also retains allowlisted named POIs without aliases for ambient map publication. It does not invent lexical alias terms for them; existing exact/prefix alias retrieval is unchanged. Newly prepared snapshots record ambient source format 2. Rebuild older snapshots before a planet ambient build, which requires that format to avoid silently omitting ordinary named businesses.
