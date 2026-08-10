---
title: Places & enrichment
description: The place detail panel — name, hours, contact, photos, and reviews — and the open-data sources that enrich it.
sidebar_position: 7
---

# Places & enrichment

When you pick a search result, tap a marker, or long-press a point on the map,
OpenMapX opens a **place panel** — the card on the side of the map that tells you
what a place is, when it's open, how to reach it, and what others have said. The
panel starts from a single resolved place (a name, a category, and a set of
coordinates) and layers open data on top of it: an encyclopedia summary,
structured facts, geotagged photos, opening hours, sun and weather readouts, and
a path straight into directions or transit.

Nothing here depends on one proprietary place database. The address and core
attributes come from your [geocoder](./search.md) and OpenStreetMap; everything
else is contributed by *enrichment integrations* you can enable, disable, or
swap independently. A place still resolves and displays with none of them — you
simply get less context.

## What a place card shows

The panel is organized into tabs across the top, with the most useful
information up front on the **Overview** tab.

The header carries the place **name**, a **category** chip (restaurant, park,
museum, airport, …), and — when reviews exist — a star rating and review count.
If the place has photos, a hero image sits above the header with a **View
photos** affordance that opens the full gallery. Cities and smaller
administrative areas get a compact local-time and weather readout in the header
instead of a photo.

Below the header, a row of round **action buttons** is always present:

| Action         | What it does                                                                 |
| -------------- | ---------------------------------------------------------------------------- |
| **Directions** | Sets this place as the destination and opens the [directions panel](./directions.md) |
| **Save**       | Adds the place to one of your [saved lists](./saved-places.md) (sign-in required) |
| **Nearby**     | Opens the Explore box centered on this place to find what's around it         |
| **Share**      | Copies a deep link to the place (uses the native share sheet where available) |

### The Overview tab

Overview is a stack of detail rows, each self-hiding when it has nothing to show:

- **Address** — the formatted street address, with a one-tap copy button.
- **Plus Code** — an [Open Location Code](https://plus.codes/) for the exact
  point, shortened against the nearest city and linking out to plus.codes.
- **Opening hours** — parsed from OpenStreetMap's `opening_hours`, shown as an
  **open / closed** status with the next change, and expandable to the full week
  schedule with today highlighted.
- **Phone** and **Website** — tap-to-call and click-through links, each copyable.
- **Wikipedia** — a link to the article when the place is linked to one.
- **Add a label** — tag the place as Home, Work, or a custom name for fast recall.
- **Weather**, **Sunrise & sunset**, and (on the coast) **Tides** and **Marine
  weather** — expandable readouts for the place's exact location.

Restaurants can surface a menu link and a food-delivery hand-off. The delivery
picker supports Uber Eats, Wolt, Lieferando, DoorDash, Deliveroo, Just Eat,
Glovo, foodpanda, Grubhub, iFood, Rappi, PedidosYa, Swiggy, Zomato, and Talabat.
It resolves an exact Uber Eats store only when the match is safe; otherwise it
opens a provider search for the restaurant and location rather than claiming a
confirmed menu. Ordering, availability, prices, and tracking remain external.

Hotels surface comparison links for Booking.com, Expedia, Hotels.com, Agoda,
and Trip.com, plus a dedicated **Prices** tab. A configured LiteAPI key can add
a live lowest-nightly-rate result; without it the feature remains a deep-link
comparison. Affiliate IDs/wrappers are optional, and booking happens externally.
Both restaurant and hotel rows stay hidden for places they don't apply to. Below
the rows, the Overview tab also folds in
specialized sections when the place warrants them — a **transit** section for a
place with linked stops (feeding into [public transit](./public-transit.md)),
data-source detail (such as EV-charging connectors, see
[mobility data](./mobility-data.md)), airport detail (runways, frequencies,
navaids), and harbor facilities for nautical points.

### The Reviews tab

Reviews aggregates ratings and written reviews for the place and lets signed-in
users write their own. The full mechanics — the open Mangrove review store,
browser-side signing, and how a place is matched to its reviews — are covered on
the [Reviews](./reviews.md) page.

### The Info tab

Info is the deeper reference view. It leads with a longer description (the
Wikipedia summary when available, the Wikidata description otherwise), then a
grid of **About this place** facts, structured attribute groups read from
OpenStreetMap tags (accessibility, payment methods, service options, diet,
internet access, recycling, and so on), and a list of **external references** —
the place's IDs on Wikidata, OpenStreetMap, and other registries, each linking
out. Every block credits its source inline.

## How enrichment works

A resolved place is enriched the same way no matter how it was found. The API
runs every enabled **knowledge** integration in parallel against the place's
OpenStreetMap tags and coordinates, then merges the results into one place
object: scalar fields (description, Wikipedia link) take the first non-empty
answer, while facts and photos from all sources are concatenated and
deduplicated. Any source that errors or times out is silently dropped, so
enrichment degrades gracefully rather than blocking the panel.

### Knowledge integrations

These add the context behind the core place data. Each is an independent plugin
in the `knowledge` domain.

| Integration               | Contributes                                                                          | Source license      |
| ------------------------- | ------------------------------------------------------------------------------------ | ------------------- |
| `knowledge-wikipedia`     | The article summary shown on Info, plus the Wikipedia link and Commons images        | CC BY-SA / GFDL     |
| `knowledge-wikidata`      | The "About this place" structured facts and a fallback description                    | CC0                 |
| `knowledge-sunrise-sunset`| Sunrise, sunset, and day-length for the place's exact coordinates                     | Free with attribution |

A place is matched to Wikipedia and Wikidata through its OSM `wikipedia` and
`wikidata` tags (and the geocoder fills these in where it can), so the encyclopedia
content lines up with the right entity rather than a name guess.

The same panel can surface a few more location readouts that are documented on
their own pages, since they're really weather data: current conditions, tides
near a coast, and marine (wave) weather all appear as expandable rows when
relevant. See [Weather](./weather.md) for those sources.

### Photo integrations

Geotagged imagery comes from a separate set of plugins in the `photos` domain. A
single request fans out to every enabled photo provider — some matched by the
place's OSM tags (`image`, `wikidata`, `wikimedia_commons`), others by a
geo-search around the coordinates — and the results are merged and deduplicated
into one gallery. Street-level imagery providers are sorted last, after editorial
photos.

| Integration        | Source            | Notes                                                          |
| ------------------ | ----------------- | -------------------------------------------------------------- |
| `photos`           | OSM `image=` tags, Google Photos previews | The base provider; resolves image tags and link previews |
| `photos-wikimedia` | Wikimedia Commons | Tag-linked and geo-searched Commons photos                     |
| `photos-flickr`    | Flickr            | Geotagged photos (needs a Flickr API key)                      |
| `photos-panoramax` | Panoramax         | Open street-level imagery (sorted after editorial photos)      |
| `photos-mapillary` | Mapillary         | Street-level imagery (sorted last; needs an access token)      |

Each photo carries its own attribution, shown in the gallery, and the OSM
`image=` tag always takes priority as the place's primary picture. The same
Mapillary and Panoramax coverage also powers the immersive viewer described under
[Street-level imagery](./street-level-imagery.md).

:::note[Every upstream call is proxied]
Like the rest of OpenMapX, enrichment requests run through your own server —
Wikipedia, Wikidata, Flickr, and the rest see your server's address, not your
users'. Images are fetched through an image proxy on the same server.
:::

## Configuring enrichment

Enrichment integrations are managed from the admin panel, the same way as any
other [integration](../overview/how-it-works.md). Enable only the sources you
want; the place panel adapts to whatever is running. A few providers need
credentials — Flickr an API key, Mapillary an access token — which live in the
integration's config alongside its enabled toggle. The knowledge and Commons
providers call public APIs and need no key.

Food-delivery and hotel link-outs have their own integration settings. Operators
can select providers, add affiliate wrappers/IDs, and configure LiteAPI for live
hotel rates. A link-out exposes the chosen search to the external site only
after the user opens it; it is not a proxied provider API call.

Because results are merged rather than ranked into a single winner, enabling more
sources generally means richer cards: Wikipedia plus Wikidata plus several photo
providers all contribute at once, while each stays optional. For the underlying
plugin model and how integrations resolve against backend services, see
[How it works](../overview/how-it-works.md).

## Related features

- **[Search & autocomplete](./search.md)** — how a place is found and resolved
  before the panel opens, including category and POI search.
- **[Saved places](./saved-places.md)** — the Save button's lists and labels, and
  exporting a list as GPX, GeoJSON, or KML.
- **[Directions](./directions.md)** — the Directions action drops you into route
  planning with this place as the destination.
- **[Public transit](./public-transit.md)** — the transit section of a place with
  linked stops, and stop detail panels.
- **[Reviews](./reviews.md)** — the Reviews tab, ratings, and writing reviews.
- **[OpenStreetMap contributions](./osm-contributions.md)** — correcting a name,
  category, hours or contact detail on the underlying OpenStreetMap element from
  the place panel.
- **[Street-level imagery](./street-level-imagery.md)** — the Mapillary and
  Panoramax viewer that the photo providers also feed.
- **[Mobility data](./mobility-data.md)** — the data-source detail sections for
  EV charging, parking, and shared-mobility points.
