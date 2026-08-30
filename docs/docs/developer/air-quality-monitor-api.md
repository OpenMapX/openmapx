---
title: Air-quality monitor API
description: Canonical viewport station contract, immutable cursors, thinning, and client lifecycle rules.
sidebar_position: 10
---

# Air-quality monitor API

The first-party monitor map consumes only:

```http
GET /api/integrations/air-quality/stations
```

This is a bounded GeoJSON endpoint owned by the canonical `air-quality`
integration. First-party code must not parse or depend on the legacy
`overlay-air-quality` station array.

## Query contract

`south`, `west`, `north`, and `east` are required finite WGS84 coordinates.
South must be below north. A box may cross the antimeridian by setting `west`
greater than `east`; its unwrapped span still cannot exceed 30 longitude
degrees. Latitude span is limited to 20 degrees.

| Parameter | Requirement |
| --- | --- |
| `south`, `north` | `-90` through `90`; span at most 20° |
| `west`, `east` | `-180` through `180`; unwrapped span at most 30° |
| `zoom` | Optional integer `0`–`22`; defaults to `0` |
| `pollutant` | Optional: `pm25`, `pm10`, `o3`, `no2`, `so2`, `co`, `nh3`, or `no`; defaults to `pm25` |
| `limit` | Optional integer `1`–`500`; defaults to `500` |
| `cursor` | Optional opaque continuation token, at most 2,048 characters |

Every scalar query key may occur only once. Invalid or repeated input returns
HTTP 400 `INVALID_QUERY`.

## GeoJSON response

The response is a `FeatureCollection` with `features`, `nextCursor`, and `meta`.
Every feature is a Point with a stable opaque station ID and one selected raw
pollutant summary. Properties include:

- pollutant, non-negative value in the map's canonical `ug/m3` unit, interval start/end,
  and observation time;
- freshness and quality status;
- station class and fixed/mobile state;
- completeness percentage plus estimated and gap-filled flags;
- provider ID, contributing source IDs, owner, and an optional published local
  index summary.

`meta` describes the candidate, served, failed, and policy-excluded providers;
cache state; truncation; candidate/served/skipped counts; and warnings such as
`stale_evidence`, `partial_providers`, `policy_excluded`, or
`quota_truncated`. Missing evidence is a valid empty GeoJSON response, not a
fabricated zero concentration.

The server deterministically keeps one winner per `zoom + 4` Web Mercator cell.
Freshness, station class, mobile status, evidence basis, observation time,
provider priority, and stable identity form the tie-break order. Dense
viewports therefore remain bounded and repeatable.

Before projection, `mg/m3` values are converted to `ug/m3`. Dimensionally
incompatible `ppb` and `ppm` values are omitted because the service has no
temperature, pressure, and molecular conversion context; omissions contribute
to `meta.skippedCount`. This guarantees that the shared numeric color scale
never compares unlike units.

## Immutable pagination

The first request materializes an ordered snapshot for five minutes, capped at
2,000 features and eight MiB in the distributed runtime. The signed cursor
contains only snapshot identity, query binding, schema revision, and offset;
station data is not embedded in it. Later pages read that same snapshot even if
an upstream provider changes.

A cursor is bound to the complete query, including limit and pollutant. A
tampered or cross-query cursor returns HTTP 400. An expired snapshot, expired
cursor, or changed source-policy fingerprint returns HTTP 409
`CURSOR_EXPIRED`. The map client restarts once without a cursor and never mixes
pages from the old and new snapshots.

## Client lifecycle requirements

The canonical client requests 500 features per page and publishes only after
the final page or its 2,000-feature cap. Each viewport load uses one abort
signal. A replacement request, layer hide, mode change, or unmount aborts it,
and only the newest still-visible request may publish.

Transient refresh errors preserve the previous completed snapshot and its exact
source attribution. A pollutant change is different: the prior pollutant is no
longer truthful for the selected mode, so its retained payload is cleared before
the replacement request. Retained GeoJSON must be replayed after MapLibre style
replacement, while detach must remove sources, layers, handlers, popup state,
attribution, and pending requests.

The public overlay/deep-link ID remains `air-quality`. The canonical manifest is
the sole frontend owner; provider integrations, including
`overlay-air-quality`, may register backend evidence but must not register a
second layer, legend, or store.
