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

| Provider type | What it is | Network |
| --- | --- | --- |
| `ollama` | A self-hosted LLM (default model `gemma3:4b-it-qat`) run by the optional `local-ai` service | None — runs on your hardware |
| `keyword` | A deterministic rule-based parser | None — always the floor of the chain |
| `anthropic` | Anthropic Claude models | Cloud — needs an Anthropic key |
| `openai` | OpenAI Responses or Chat models | Cloud — needs an OpenAI key |
| `google` | Google Gemini models | Cloud — needs a Gemini API key |
| `openrouter` | Hundreds of models through OpenRouter, with structured-output and privacy routing enforced | Cloud — needs an OpenRouter key |
| `openai-compatible` | Any endpoint implementing OpenAI-compatible chat completions and structured output | Local or cloud, declared per definition |

The `keyword` provider is always present (and appended when omitted), so even
with no LLM at all, common phrases ("coffee near me open now") still parse — the feature
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

- **`providers`** — the ordered provider definitions. Each has an operator-defined
  `id`, an adapter `type`, and type-specific settings such as `model`, `baseURL`,
  timeout, or OpenRouter routing policy.
- **`privacyMode`** — `strict`, `consent`, or `open`.
- **Credentials** — Anthropic, OpenAI, Google, OpenRouter, and compatible-endpoint
  keys live in the vault-backed Credentials tab, never in the provider JSON.

For example, a Gemini-first chain with a local fallback is:

```json
[
  { "id": "gemini", "type": "google", "model": "gemini-2.5-flash" },
  { "id": "local", "type": "ollama", "model": "gemma3:4b-it-qat" },
  { "id": "keyword", "type": "keyword" }
]
```

Provider ids are not an enum. You can configure multiple models of the same
type; cache entries include the complete provider definition, while circuit
breakers are isolated by provider id.
Arbitrary cloud-compatible endpoints must include their processor name, country,
and privacy URL so the runtime privacy page remains accurate. Their `baseURL`
must be the OpenAI-compatible API root, including `/v1` when the service expects it.

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
