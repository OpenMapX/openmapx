---
title: Places & enrichment
description: Read place details, opening hours, photos, reviews, and source credits.
sidebar_position: 7
---

# Places & enrichment

Select a search result, map marker, or dropped pin to open the place panel.
Use it to check the available address, opening hours, contacts, photos, source
credits, and related services. **Directions**, **Save**, **Nearby**, and **Share**
provide the next actions.

Details come from the selected source and enabled enrichment providers. Missing
or outdated data can leave a partial card. Opening hours, ratings, and photos
do not guarantee that a venue is currently open or accessible.

## What a place card shows

The panel is organized into tabs across the top, with the most useful
information up front on the **Overview** tab.

The header carries the place **name**, a **category** chip (restaurant, park,
museum, airport, …), and a star rating and review count when reviews exist.
If the place has photos, a hero image sits above the header with a **View
photos** affordance that opens the full gallery. Cities and smaller
administrative areas get a compact local-time and weather readout in the header
instead of a photo.

The main action row provides:

| Action         | What it does                                                                         |
| -------------- | ------------------------------------------------------------------------------------ |
| **Directions** | Sets this place as the destination and opens the [directions panel](./directions.md) |
| **Save**       | Adds the place to one of your [saved lists](./saved-places.md) (sign-in required)    |
| **Nearby**     | Opens the Explore box centered on this place to find what's around it                |
| **Share**      | Copies a deep link to the place (uses the native share sheet where available)        |

### The Overview tab

Overview is a stack of detail rows, each self-hiding when it has nothing to show:

- **Address**: the formatted street address, with a one-tap copy button.

  OpenMapX preserves available address parts and their origin when selecting
  between sources. Explicit address tags on the selected OSM object take
  precedence over inferred context; a nearby house number is never borrowed to
  complete a street-only address. Named premises and full-text addresses can be
  valid without a house number. When MapTiler supplies a direct OSM reference,
  place details use that object rather than a name-and-proximity match. Missing
  or conflicting data can still leave an address partial.

- **Plus Code**: an [Open Location Code](https://plus.codes/) for the exact
  point, shortened against the nearest city and linking out to plus.codes.
- **Opening hours**: parsed from OpenStreetMap's `opening_hours`, shown as an
  **open / closed** status with the next change, and expandable to the full week
  schedule with today highlighted.
- **Phone** and **Website**: tap-to-call and click-through links, each copyable.
- **Wikipedia**: a link to the article when the place is linked to one.
- **Add a label**: tag the place as Home, Work, or a custom name for fast recall.
- **Local time**: the current wall clock at the place, its UTC offset, and how
  far ahead or behind you it is. Shown only when the place is in a different time
  zone _and_ a different offset from yours, so a place across a border that keeps
  the same clock adds no row.
- **Weather**, **Sunrise & sunset**, and (on the coast) **Tides** and **Marine
  weather**: expandable readouts for the place's exact location.

Restaurants can show a menu link and external delivery services. An exact store
link is used only when supported matching succeeds; otherwise a provider search
can open for the restaurant and location. Check the destination before ordering.

Hotels can show comparison links and a **Prices** tab. A configured live-rate
provider can add a nightly-rate result; otherwise the feature provides links.
Availability, price, ordering, and booking belong to the external service.
Affiliate configuration can affect the outgoing link.

Applicable places can also show transit departures, charging connectors, airport
information, harbor facilities, [weather](./weather.md), and
[air quality](./air-quality.md). The air-quality request starts only when its
section is expanded.

### The Reviews tab

Reviews aggregates ratings and written reviews for the place and lets signed-in
users write their own. The review store, signing key, and matching behavior are described on
the [Reviews](./reviews.md) page.

### The Info tab

Info is the deeper reference view. It leads with a longer description (the
Wikipedia summary when available, the Wikidata description otherwise), then a
grid of **About this place** facts, structured attribute groups read from
OpenStreetMap tags (accessibility, payment methods, service options, diet,
internet access, recycling, and so on), and a list of **external references**:
the place's IDs on Wikidata, OpenStreetMap, and other registries, each linking
out. Every block credits its source inline.

## How enrichment works

Enabled providers can add descriptions, facts, photos, and location readouts.
A failed optional source can leave the rest of the card usable. Check the credits
for the data that actually contributed; enabling a source does not mean it has
information about every selected place.

### Knowledge integrations

Wikipedia can supply an article summary and linked images. Wikidata adds
structured facts and a fallback description. OSM Wikipedia and Wikidata references
help identify the subject; a matching name alone is not proof of identity.
Optional [Overture](./overture-places.md) enrichment can fill supported gaps.
Sun/time calculations and weather or tide providers supply separate location
readouts.

### Photo integrations

The gallery can combine images referenced by OpenStreetMap with Wikimedia
Commons, Flickr, Panoramax, and Mapillary, depending on configuration. Providers
can match tags or search near the coordinates. A nearby photo need not depict
the selected business. Check its source, caption, and capture information.

OSM image references receive priority; street-level photos follow editorial
photos. Each photo keeps its own attribution. The gallery's original-source
links contact the external site when opened.

Built-in provider metadata and image assets normally pass through the OpenMapX
API. Other integrations, external links, or consented media can have a different
privacy boundary. See [Street-level imagery](./street-level-imagery.md).

## Configuring enrichment

Enrichment integrations are managed from the admin panel, the same way as any
other [integration](../overview/how-it-works.md). Enable only the sources you
want; the place panel adapts to whatever is running. A few providers need
credentials, such as a Flickr API key or Mapillary token, which live in the
integration's config alongside its enabled toggle. The knowledge and Commons
providers call public APIs and need no key.

Food-delivery and hotel link-outs have their own integration settings. Operators
can select providers, add affiliate wrappers/IDs, and configure LiteAPI for live
hotel rates. A link-out exposes the chosen search to the external site only
after the user opens it; it is not a proxied provider API call.

For the provider and service model, see [How it works](../overview/how-it-works.md).

## Related features

- **[Search & autocomplete](./search.md)**: how a place is found and resolved
  before the panel opens, including category and POI search.
- **[Saved places](./saved-places.md)**: the Save button's lists and labels, and
  exporting a list as GPX, GeoJSON, or KML.
- **[Directions](./directions.md)**: the Directions action drops you into route
  planning with this place as the destination.
- **[Public transit](./public-transit.md)**: the transit section of a place with
  linked stops, and stop detail panels.
- **[Reviews](./reviews.md)**: the Reviews tab, ratings, and writing reviews.
- **[OpenStreetMap contributions](./osm-contributions.md)**: correcting a name,
  category, hours or contact detail on the underlying OpenStreetMap element from
  the place panel.
- [Personal timeline](./personal-timeline.md): open a read-only day view from a
  connected Dawarich account. This is a separate view, not a place-card visit counter.
- **[Street-level imagery](./street-level-imagery.md)**: the Mapillary and
  Panoramax viewer that the photo providers also feed.
- **[Mobility data](./mobility-data.md)**: the data-source detail sections for
  EV charging, parking, and shared-mobility points.
