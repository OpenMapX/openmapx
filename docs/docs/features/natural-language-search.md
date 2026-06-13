---
title: Natural-language search
description: Type a question instead of a keyword. OpenMapX parses plain-language searches into a structured intent — local-first by default, with optional cloud models behind explicit consent.
sidebar_position: 2
---

# Natural-language search

Sometimes you don't know the name of a place — you know what you want from it.
"Quiet vegan cafe with wifi near the park, open now." Natural-language search
turns a sentence like that into a real search: it reads the query, works out the
categories, filters, area, and hours you're asking for, and runs them through the
same category and place search the rest of the app uses.

It sits *alongside* ordinary search, never in front of it. When the search bar
recognizes a query as a question rather than a place name, it offers a separate
natural-language suggestion above the usual autocomplete results. Pick it and the
map fills with matches; ignore it and your normal results are untouched.

## What it understands

A parsed query becomes a structured **search intent**:

| Part of the query | Becomes… |
| --- | --- |
| "cafe", "pharmacy", "EV charging" | One or more **categories** to search |
| "vegan", "with wifi", "wheelchair", "outdoor seating" | **OSM attribute filters** |
| "near the park", "near me", "in Berlin" | A **spatial constraint** (resolved to an area — place names through your geocoder) |
| "open now", "open 24h", "open Monday at 9" | A **time constraint** wired into the opening-hours filter |
| "nearest", "best", "top-rated" | A **sort order** (distance / rating) |
| "quiet", "cozy", "cheap" | **Unmapped qualities** — noted, but with no OSM tag to filter on |

The intent also carries a confidence score; low-confidence parses — and queries
that look like a proper place name — are dropped, so a misread never hijacks an
ordinary search.

## Local-first by default

Parsing runs through an **ordered provider chain**, tried left to right until one
returns a usable intent. The default chain is `local, keyword`:

| Provider | What it is | Network |
| --- | --- | --- |
| `local` | A self-hosted LLM (Ollama, default model `gemma3:4b-it-qat`) run by the optional `local-ai` service | None — runs on your hardware |
| `keyword` | A deterministic rule-based parser | None — always the floor of the chain |
| `claude` | Anthropic's hosted models (default `claude-haiku-4-5-20251001`) | Cloud — needs an API key |
| `openai` | OpenAI's hosted models (default `gpt-4o-mini`) | Cloud — needs an API key |

The `keyword` provider is always kept at the end of the chain, so even with no
LLM at all, common phrases ("coffee near me open now") still parse — the feature
degrades, it doesn't break.

:::note[Cloud is off until you turn it on]
A cloud provider is only ever used if it is **both** listed in the chain **and**
configured with its API key. Out of the box there are no keys, no cloud calls,
and nothing is sent to a third-party model.
:::

## Privacy

The feature is built so that no query leaves your server unless an operator and a
user both opt in:

- **`privacyMode: strict`** is a server-side hard floor. Cloud providers are
  stripped from every request regardless of any client setting — useful when you
  want a guarantee that searches stay on-premises.
- **`privacyMode: consent`** (the default) keeps cloud providers available but
  the web app gates them: the first time a result would come from a cloud model,
  the user is asked to enable it. Declining is remembered and re-runs the search
  locally from then on.
- Only the **query text and an approximate (rounded) map center** are ever sent to
  a model — never an account, a precise location, or an address.
- Parsed intents are cached per privacy posture, so a cloud-derived result can
  never be served to a later no-cloud request for the same query.

When a cloud provider is active, OpenMapX also discloses it automatically on your
`/terms` and `/privacy` pages — see
[Data-use policy & disclosure](../administration/integrations-administration.md#ai-assisted-search-disclosure).

## Configuring it

All of this lives in the **`search-nlp`** integration at `/admin/integrations` —
no environment variables required. The keys you'll touch most:

- **`providerChain`** — the ordered list, e.g. `["local","keyword"]` or
  `["claude","local","keyword"]`.
- **`privacyMode`** — `strict`, `consent`, or `open`.
- **`anthropicApiKey` / `openaiApiKey`** — supply a key to activate that cloud
  provider; without it, the provider is silently skipped.
- **`ollamaModel` / `ollamaEndpoint`** — the local model and where to reach it.

To run the local model, enable the **`local-ai`** backend
[service](../install/managing-services.md) (Ollama). The configured model is
pulled automatically on first start. See
[Configuration](../install/configuration.md#natural-language-search) for the
full key list and how to pin values from `.env`.

:::caution[Local inference needs RAM]
The `local-ai` service reserves ~8 GB by default. A small instruction-tuned
model like `gemma3:4b-it-qat` runs comfortably on CPU; larger models benefit
from a GPU. If you'd rather not host a model, use the `keyword` floor alone, or
opt into a cloud provider with `privacyMode: consent`.
:::

## Related features

- **[Search & autocomplete](./search.md)** — the geocoding and category search
  that natural-language intents ultimately drive.
- **[Places & enrichment](./places.md)** — the POI search and place panel that
  category results open into.
