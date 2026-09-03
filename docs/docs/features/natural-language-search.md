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

Under the hood, OpenMapX validates every parsed category and filter against a
strict semantic taxonomy of 40+ canonical categories and verified OSM key/value
pairs (such as `cuisine`, `diet:vegan`, `wheelchair`, `internet_access`, `opening_hours`,
and `charge:fee`). Any hallucinated or unmappable tags returned by LLM providers are
safely stripped or demoted to freeform query tokens before hitting search backends.

## Provider architecture

Parsing runs through one **ordered provider array**, tried from left to right.
The first provider that returns a valid structured intent wins. A failed or
timed-out provider does not fail the search: OpenMapX continues to the next
definition. If the array contains no `keyword` definition, the deterministic
keyword parser is appended automatically as the final safety net.

The default is entirely local:

```json
[
  { "id": "local", "type": "ollama", "model": "gemma3:4b-it-qat" },
  { "id": "keyword", "type": "keyword" }
]
```

| Provider type | What it connects to | Credential | Cloud |
| --- | --- | --- | --- |
| `keyword` | Built-in deterministic parser | None | No |
| `ollama` | Ollama's OpenAI-compatible API | None | No; public endpoints are rejected |
| `anthropic` | Anthropic Claude | `anthropicApiKey` | Yes |
| `openai` | OpenAI Responses or Chat Completions | `openaiApiKey` | Yes |
| `google` | Google Gemini | `googleApiKey` | Yes |
| `openrouter` | OpenRouter and its model/provider catalogue | `openrouterApiKey` | Yes |
| `openai-compatible` | Any compatible local or hosted endpoint | `compatibleApiKey` or none | Declared by `local` |

All model-backed providers use the AI SDK through direct provider instances.
OpenMapX does not route them through the Vercel AI Gateway, so no Vercel account,
gateway key, or gateway model identifier is involved.

### Common provider fields

Every definition has an operator-chosen `id`; it is not restricted to a fixed
provider enum. This allows multiple models or endpoints of the same type in one
chain.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Unique lowercase identifier, 1–64 characters: letters, digits, `.`, `_`, and `-` |
| `type` | Yes | One of the provider types listed above |
| `label` | No | Operator-facing/result label; otherwise derived from type and model |
| `model` | All except `keyword` | Exact model identifier understood by that provider |
| `timeoutMs` | Model-backed types only | Per-attempt timeout, 250–120,000 ms; defaults to 10 seconds for Ollama and 3 seconds for the other adapters |

Provider order is significant. Provider IDs must be unique even when their
types differ. The full normalized definition participates in the intent-cache
key, while the short-lived circuit breaker is isolated by provider ID.
Definitions of the same built-in type share that type's vault credential; each
definition can still select a different model, label, timeout, and position.

### Provider-specific fields

`keyword` has no additional fields.

| Type | Additional fields |
| --- | --- |
| `ollama` | Optional `baseURL`, which must use a private/local hostname or IP. OpenMapX appends `/v1` and defaults to the enabled `local-ai` service, then `http://localhost:11434`. |
| `openai` | `api` may be `responses` (default) or `chat`. |
| `openrouter` | `providerOrder` (default `[]`), `allowFallbacks` (default `true`), `dataCollection` (`deny` by default), and `zeroDataRetention` (`true` by default). |
| `openai-compatible` | `baseURL`, `credential` (`compatibleApiKey` by default, or `none`), `supportsStructuredOutputs` (default `true`), `local` (default `false`), and processor metadata for cloud endpoints. |

The built-in Anthropic, Google, and OpenAI adapters need only their model and
optional common fields.

### Gemini

Store `googleApiKey` on the Credentials tab, then put a Google definition in the
array. This example tries Gemini, then local Ollama, then keyword parsing:

```json
[
  { "id": "gemini", "type": "google", "model": "gemini-2.5-flash" },
  { "id": "local", "type": "ollama", "model": "gemma3:4b-it-qat" },
  { "id": "keyword", "type": "keyword" }
]
```

### OpenAI and Anthropic

```json
[
  { "id": "openai-fast", "type": "openai", "model": "gpt-5-mini" },
  { "id": "claude", "type": "anthropic", "model": "claude-haiku-4-5" },
  { "id": "keyword", "type": "keyword" }
]
```

Set `api: "chat"` on an OpenAI definition only when the selected model or
deployment requires Chat Completions. Anthropic definitions mark the stable
system prompt for provider-side ephemeral prompt caching.

### OpenRouter

OpenRouter provides broad model coverage without adding a new OpenMapX adapter
for every inference vendor. OpenMapX always asks OpenRouter to choose only routes
that support the required parameters. Its defaults deny data collection and
require zero-data-retention routes.

```json
[
  {
    "id": "router",
    "type": "openrouter",
    "model": "google/gemini-2.5-flash",
    "providerOrder": ["Google"],
    "allowFallbacks": false,
    "dataCollection": "deny",
    "zeroDataRetention": true
  },
  { "id": "keyword", "type": "keyword" }
]
```

`providerOrder` uses OpenRouter's provider identifiers. Keeping it empty lets
OpenRouter select among compatible routes. Relaxing `dataCollection` or
`zeroDataRetention` is an explicit operator decision; it may increase route
availability but changes the privacy posture.

### OpenAI-compatible endpoints

Use this adapter for services such as vLLM, LM Studio, Groq, or another API that
implements OpenAI-compatible chat completions. Give it a dedicated
`compatibleApiKey`; standard OpenAI, Anthropic, Google, and OpenRouter secrets
cannot be selected here, preventing accidental credential disclosure to a
custom URL.

A local vLLM service can be configured without a credential:

```json
[
  {
    "id": "vllm",
    "type": "openai-compatible",
    "model": "local-instruct-model",
    "baseURL": "http://vllm:8000/v1",
    "credential": "none",
    "local": true,
    "supportsStructuredOutputs": true
  },
  { "id": "keyword", "type": "keyword" }
]
```

A cloud-compatible endpoint must use HTTPS and include processor disclosure
metadata. OpenMapX uses that metadata to build the live privacy table:

```json
[
  {
    "id": "groq",
    "type": "openai-compatible",
    "model": "llama-3.3-70b-versatile",
    "baseURL": "https://api.groq.com/openai/v1",
    "credential": "compatibleApiKey",
    "local": false,
    "processor": {
      "id": "groq",
      "name": "Groq",
      "countryCode": "US",
      "privacyUrl": "https://groq.com/privacy-policy/"
    }
  },
  { "id": "keyword", "type": "keyword" }
]
```

Set `supportsStructuredOutputs` to `false` if the compatible service accepts
JSON mode but not OpenAI-style `json_schema`. OpenMapX still validates the
returned object before using it.

## Structured output and fallback behavior

The AI SDK gives every model the same typed-output interface, but provider JSON
Schema dialects differ. OpenMapX therefore uses a portable wire schema with
required arrays and nullable variant fields—avoiding unions that Gemini's
structured-output API cannot accept—then normalizes and validates it against the
stricter application intent schema.

Each attempt uses:

- structured object output with schema validation;
- temperature `0` and a 1,024-token output limit;
- no SDK-level retry (`maxRetries: 0`), because the ordered chain owns fallback;
- an explicit per-provider timeout; and
- AI SDK telemetry disabled.

Invalid JSON, schema violations, provider errors, and timeouts all move to the
next provider. A failed cloud provider opens a 60-second circuit breaker so
subsequent searches do not repeatedly wait for an unhealthy service.

## Privacy and consent

Cloud access is fail-closed at both the client and integration boundary:

- **`privacyMode: strict`** always removes network providers, even if a client
  sends a positive cloud-consent signal.
- **`privacyMode: consent`** (default) requires an explicit positive consent
  signal on every cloud-authorized request. Missing or unknown values mean
  local-only. The first browser request is local-only; if cloud is available,
  the user can enable it and the search is repeated against the full chain.
- **`privacyMode: open`** permits policy-deferred cloud access. The browser still
  begins with a local-only policy-discovery request, then repeats against the
  full chain. A user's previously remembered decline continues to win.

Only the **query text and rounded map center** are included in the model prompt.
Account identity, exact device location, and the map bounding box are not sent.
Cache keys include the complete provider chain and whether cloud was authorized,
so a cloud-produced result cannot satisfy a local-only request.

When cloud is active, OpenMapX publishes secret-free processor metadata on the
legal pages. Built-in providers supply their own metadata; custom cloud-compatible
definitions must supply `id`, `name`, `countryCode`, and an HTTPS `privacyUrl`.
See [AI-assisted search disclosure](../administration/integrations-administration.md#ai-assisted-search-disclosure).

:::note[Cloud is off by default]
A cloud adapter must be present in `providers`, its credential must exist, and
the active privacy policy must authorize the request. The shipped configuration
has no cloud definition or cloud credential.
:::

## Administration and operational settings

Configure **`search-nlp`** under `/admin/integrations`. Provider definitions are
edited as JSON; the API validates nested objects, discriminated provider shapes,
URLs, conditional processor requirements, bounds, and unknown properties before
saving them. Credentials remain in the vault-backed Credentials tab.
`providers` is the sole provider/model configuration surface; there is no
parallel per-vendor model or endpoint setting.

| Setting | Default | Meaning |
| --- | --- | --- |
| `providers` | Local Ollama, then keyword | Ordered definitions described above |
| `privacyMode` | `consent` | `strict`, `consent`, or `open` |
| `roundCoordsDecimals` | `2` | Coordinate precision included in the model prompt and intent cache key |
| `intentCacheTtlSeconds` | `86400` | Parsed-intent cache lifetime |
| `rateLimitPerIpPerHour` | `200` | Fixed-window parse limit per client IP |

Definitions whose required credential is absent are skipped with an operator
warning. If the whole provider array is invalid—for example, duplicate IDs or a
public endpoint marked `local`—OpenMapX logs the validation error and uses the
safe local-first defaults.

To run Ollama, enable the optional **`local-ai`** backend
[service](../install/managing-services.md). OpenMapX checks each configured
Ollama model during setup and pulls a missing model as a best-effort background
operation.

See [Configuration](../install/configuration.md#natural-language-search) for
environment overrides and service resource settings.

:::caution[Local inference needs RAM]
The `local-ai` service reserves about 8 GB by default. A small instruction-tuned
model such as `gemma3:4b-it-qat` can run on CPU; larger models benefit from a GPU.
If you do not want local inference, use the keyword parser alone or configure a
cloud provider under the desired privacy mode.
:::

## Parse API

Custom clients can call `POST /api/integrations/search-nlp/parse`. The request
body is:

```json
{
  "query": "wheelchair-accessible museums near the station",
  "mapCenter": [13.405, 52.52],
  "mapBbox": {
    "south": 52.48,
    "west": 13.32,
    "north": 52.56,
    "east": 13.49
  },
  "lang": "en",
  "cloudAccess": "deny"
}
```

`mapCenter` is `[longitude, latitude]`. `query`, `mapCenter`, and `mapBbox` are
required; `lang` is optional. `cloudAccess` is deliberately explicit and
fail-closed:

| Value | Behavior |
| --- | --- |
| `deny` | Local and keyword providers only; also the default for missing or unknown values |
| `consented` | Allows cloud in `consent` and `open`; `strict` still overrides it |
| `defer-to-server` | Allows cloud only when the operator selected `open` |

The response includes the validated `intent`, its `resolvedBbox`, provider ID
and label, whether that result used cloud, whether cloud is available under the
current policy and needs consent, the available cloud provider labels, and
whether the intent came from cache. A request rejected by the hourly limit returns `429` with
`Retry-After: 3600`; complete provider-chain failure returns `502`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Cloud definition never runs | Confirm the matching vault credential exists, the provider is before `keyword`, and privacy mode/consent permits cloud. |
| Custom endpoint is rejected | Cloud endpoints require HTTPS and processor metadata; local endpoints require a private hostname/IP. |
| Compatible endpoint rejects `response_format` | Set `supportsStructuredOutputs` to `false`. |
| Ollama requests use the wrong path | Configure the Ollama server root; OpenMapX appends `/v1`. |
| Every model falls back to keyword | Inspect provider warnings for timeout, invalid model ID, or structured-output validation errors. |
| A recently failed cloud provider is skipped | Wait up to 60 seconds for its circuit breaker after correcting the underlying problem. |

## Related features

- **[Search & autocomplete](./search.md)** — the geocoding and category search
  that natural-language intents ultimately drive.
- **[Places & enrichment](./places.md)** — the POI search and place panel that
  category results open into.
