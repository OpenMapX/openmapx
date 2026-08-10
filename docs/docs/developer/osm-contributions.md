---
title: OSM contributions
description: The trust boundary, tag policy, changeset lifecycle and operational contract behind OpenStreetMap place contributions.
---

# OSM contributions (developer notes)

This is the safety design behind the
[place contribution feature](../features/osm-contributions.md). Read it before
changing anything under `apps/api/src/services/osm-contributions/`,
`packages/presets/src/editor-*`, or the contribution UI.

The feature writes to a **public, shared, hard-to-repair database** under a real
person's name. Most of what follows exists to make a whole class of mistake
structurally impossible rather than merely unlikely.

## Trust boundary

```text
browser  →  semantic operations only
             ↓
apps/api  →  live OSM read, tag policy, XML, changeset lifecycle
             ↓
OpenStreetMap
```

The browser can express only a small **semantic** operation: "set the name to
X", "remove the phone number", "change the category to this preset id". It
cannot send a tag key, a tag map, a coordinate, a version, a changeset, or an
upstream URL. Those requests are rejected by `.strict()` Zod schemas in
`@openmapx/core` before a route handler runs.

Everything that turns a semantic operation into tags lives in
`tag-policy.ts` on the server, and preview and publish call the *same* pure
function — so what a person approves is exactly what is sent.

## Tag ownership

Each field owns a bounded set of keys:

| Field | Owned keys |
| --- | --- |
| Name | `name` only — never `name:<lang>`, `alt_name` or `official_name` |
| Category | the concrete identifying tags of one iD preset |
| Address | only `addr:*` keys already present on that exact element |
| Opening hours | `opening_hours` |
| Phone / email / website | whichever of `x` / `contact:x` already exists |
| Accessibility | `wheelchair` |

When both alias keys exist, the field is **disabled** rather than merged. When
no address exists, one cannot be introduced.

After the mutation, `assertOnlyOwnedKeysChanged()` compares the result against
the base and **throws** if any key outside the computed ownership set differs.
That is an enforced invariant, not a test expectation — a future field cannot
quietly widen what an edit touches.

## Preset policy

`@openmapx/presets`' editor index is deliberately separate from the search
index, so changing an editor safety rule can never move a place-search result.
A category is editable only when the match is a **unique** concrete preset.
Ties, wildcard-only matches (`shop=*`), deprecated presets and lifecycle states
(`disused:`, `demolished:`, …) all disable the field.

Way geometry is inferred conservatively: a closed way is not evidence of an
area. Only explicit `area=yes`/`area=no` or an unambiguous geometry-neutral
preset match decides; anything else is `unknown`, which disables category
editing while leaving scalar fields available.

## Full-element preservation

OSM's update endpoint requires a **complete** representation, so a missing
`<nd>` or `<member>` silently destroys geometry. `OsmWritableElement` therefore
requires the geometry/member properties at compile time, and `osm-xml.ts` builds
output with `fast-xml-parser` — never string concatenation, so escaping is not a
per-call decision. Unknown tags, localized names, node references, relation
members and roles all survive verbatim.

## Exact versioning and the changeset lifecycle

`publish()` runs in a fixed order, and the service tests assert the call order:

1. validate the request;
2. check both feature flags and the live account state;
3. acquire the submission guard / idempotency record;
4. fetch the current element;
5. require `current.version === baseVersion` exactly;
6. apply the policy and verify the complete result;
7. create the changeset;
8. update **exactly one** element;
9. close the changeset in `finally`;
10. store the sanitized outcome and release the guard.

Everything that can fail validation happens **before** a changeset exists.
Closing is the only safely repeatable mutation here, and only when the changeset
is confirmed still open. An unconfirmed close is an operational signal — it must
never turn a confirmed element update into a client-visible failure.

## Timeout reconciliation

A lost response is **never** retried blindly. If an update may have been
transmitted, the service re-reads the element and the known changeset:

- matching changeset id, incremented version and the exact expected tags →
  success;
- byte-identical unchanged base → safe failure, retryable;
- anything else → `AMBIGUOUS_RESULT` with trusted inspection links and no retry.

If changeset *creation* itself times out without returning an id, there is
nothing to address: no update is sent, creation is not retried, and the unknown
empty changeset is left for OSM to expire.

## Token handling

Sign-in keeps the minimal `openid read_prefs` scopes. `write_api` and
`write_notes` are requested incrementally, only when someone starts
contributing.

Provider tokens are encrypted at rest (`account.encryptOAuthTokens`). Nothing
reads the token column directly — the usable token is resolved through Better
Auth's public server API. Permission is read from OSM's own `/permissions`
endpoint, never from the locally stored scope string, so a revoked authorization
cannot look effective.

:::warning
Better Auth's generic-OAuth **link** route uses `body.scopes || configuredScopes`
— a supplied array *replaces* the provider defaults (the sign-in route
concatenates instead). Since one provider token is stored per account, an
authorization request must always carry base identity **plus** the intended
action scope **plus** any contribution scope already in effect. Sending only the
missing scope silently revokes the other one.
:::

## Idempotency and rate limits

Two records per submission: a short lock keyed by user + element + operation,
and a longer idempotency record keyed by user + operation + the client's UUID.
Both keys are HMAC-SHA-256 digests under a server-only secret, and stored values
hold only public result ids, trusted URLs and timestamps.

Redis is used when configured, with a bounded in-memory fallback. **Correctness
never depends on it** — OSM's exact element version remains the cross-instance
data-safety boundary.

Per-user limits default to 60 reads, 30 previews, 10 publishes and 5 notes per
10 minutes, each tunable via `RATE_LIMIT_OSM_CONTRIBUTION_*`.

## Telemetry is content-free

Two instruments only:

```text
osm_contribution_operations_total{operation,outcome}
osm_contribution_operation_duration_ms{operation,outcome}
```

Both labels are closed enums. No user or account id, element type or id, field,
preset, locale, evidence, source, changeset or note id, token, URL, request id
or response body may ever become a label or a log argument. Logs carry the
operation, the outcome, a duration and a randomized request id — nothing else.

## Feature flags

- `OSM_CONTRIBUTIONS_ENABLED` — master flag. Controls discovery: the public
  `/api/capabilities` response exposes only whether this **and** OAuth
  configuration are on, so signed-out clients can hide unreleased UI without
  revealing anyone's linked-account state.
- `OSM_DIRECT_EDITING_ENABLED` — independent kill switch for element writes.
  Turning it off does **not** convert a requested edit into a note.

Both default false, and every mutation re-checks them, so a cached UI cannot
bypass a kill switch.

## Adding a field later

A new editable fact cannot be added in the browser alone. Every field needs all
of the following before it ships:

1. the authoritative OSM tag/preset semantics, written down;
2. the exact owned keys, and the alias rule when more than one key exists;
3. which geometries it applies to;
4. what deletion means for it, and whether deletion is safe at all;
5. visible, non-lossy validation with tested boundaries;
6. its appearance in the exact tag diff;
7. preservation tests proving unrelated tags and structures are untouched;
8. UI copy, translations, and any legal/privacy copy it affects;
9. verification against the OSM **development** API.

## Incident response

If an ambiguous result, a preservation bug, a content leak, an unexpected OSM
community complaint or repeated upstream write failures appear, set
`OSM_DIRECT_EDITING_ENABLED=false` immediately. Disable the master flag as well
if account gating or notes are implicated. Both are runtime configuration; no
code change or deploy is required to stop writing.

## This is not an automated edit process

Every changeset here is initiated by a person, for one element, with their own
comment and stated source. If future behavior ever becomes automated or batched,
stop and follow the
[automated edits code of conduct](https://wiki.openstreetmap.org/wiki/Automated_Edits_code_of_conduct)
before implementing it.

Review from experienced OpenStreetMap contributors is welcome before any broad
rollout — especially on category transitions and the evidence wording. Record
actionable feedback in normal tracked issues; never in telemetry.
