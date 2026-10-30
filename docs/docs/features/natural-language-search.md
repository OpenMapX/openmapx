---
title: Natural-language search
description: Search for places using a sentence, with local parsing and optional cloud assistance.
sidebar_position: 2
---

# Natural-language search

Enter a query such as "vegan cafe with wifi near the park, open now" to search
by category, location, and available place attributes. When OpenMapX recognizes
a question, it offers a natural-language suggestion above ordinary autocomplete
results. Select that suggestion to run it; choosing a normal place suggestion
still opens that place.

Parsing begins when you submit a search. Editing the query, choosing a place,
or opening Directions cancels that submission so a late answer cannot replace
your newer action.

## What it understands

| Query detail                               | How it is used                                               |
| ------------------------------------------ | ------------------------------------------------------------ |
| "cafe", "pharmacy", "EV charging"          | Selects categories                                           |
| "vegan", "with wifi", "wheelchair"         | Filters supported OpenStreetMap attributes                   |
| "near me", "in Berlin", "near the park"    | Resolves a search area                                       |
| "open now", "open 24h", "open Monday at 9" | Applies an opening-hours filter                              |
| "nearest", "top-rated"                     | Requests a supported sort order                              |
| "quiet", "cozy", "cheap"                   | Can remain as unmapped words when no supported filter exists |

"Near me" can use the current map view; it does not guarantee a search around a
fresh device-location fix. A named area that cannot be resolved can also fall
back to the current view.

A parsed query is not a verified description of a place. Results depend on source
coverage and the tags available for each place. Check opening hours and other
details before relying on them. A model cannot make a missing source attribute
reliable, and unsupported filters are removed or retained as ordinary query words.

## Local and cloud parsing {/* #provider-architecture */}

The shipped configuration tries a local Ollama model, then the built-in keyword
parser. The keyword parser works without a model service. Operators can configure
other providers and their order; a failed attempt falls through to the next one.

Cloud providers require configuration and the instance's privacy policy must
permit their use. They are absent from the shipped provider chain. The
[provider and API reference](../developer/natural-language-search.md) covers the
available adapters and their settings.

## Fallback behavior {/* #structured-output-and-fallback-behavior */}

You can disable AI search in Settings. Low-confidence results and queries that look like ordinary place names are not
used to override normal search. Provider errors, invalid output, and timeouts
can cause another parser to answer. If parsing fails or produces no plausible intent, the browser
can still fall back to a plain search of the visible area. Reusing a cached parse
does not authorize a new cloud request.

## Privacy and consent

The model prompt contains the query and rounded map center. It excludes account
identity, exact device location, and the viewport bounding box. The query itself
can still contain personal information, so consider what you type before allowing
cloud assistance.

The instance operator selects one of these policies:

- `strict`: cloud parsing is disabled.
- `consent`: cloud parsing requires an explicit positive choice. This is the default.
- `open`: the operator permits cloud use after policy discovery; a remembered
  user decline still takes precedence.

Without remembered permission, consent mode offers cloud assistance before a
cloud-authorized parse. Review the displayed processors before enabling it.
Remembered acceptance can authorize later searches immediately; a remembered
decline takes precedence over an open policy. In open mode, discovered policy
can authorize the first parse without a preliminary local-only parse. A cloud
provider still needs its configured credential.

Model processing and result retrieval are separate steps. A local parser can
still search a hosted geocoder or POI provider through the OpenMapX server.
The instance's privacy page describes those sources.

## Configure an instance {/* #administration-and-operational-settings */}

Operators configure `search-nlp` under **Admin → Integrations**. Provider
credentials are separate from the provider-definition JSON. Local inference
requires an available model service; keyword-only parsing needs no model download.

See [Provider configuration](../developer/natural-language-search.md#administration-and-operational-settings)
for model service resources, credentials, privacy modes, caching, and request limits.

## Custom clients {/* #parse-api */}

The [parse API](../developer/natural-language-search.md#parse-api) accepts explicit
cloud authorization and returns the validated intent, resolved area, and provider
information. Clients must preserve the same consent boundary as the first-party UI.

## Troubleshooting

If a sentence produces few results, try a simpler category and area, then add
filters individually. A feature such as wheelchair access or opening hours may
be missing in the underlying data.

If cloud assistance is unavailable, the operator may have disabled it, omitted
a credential, or configured a provider that is temporarily failing. Operators
can use the [provider troubleshooting table](../developer/natural-language-search.md#troubleshooting)
and integration logs. Ordinary search remains available independently.

## Related features

- [Search](./search.md): place names, addresses, codes, and category queries.
- [Places](./places.md): source details behind a result.
