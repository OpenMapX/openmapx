---
title: Coverage & freshness
description: Read-only, evidence-backed coverage and freshness reporting for full administrators.
sidebar_position: 2
---

# Coverage & freshness

The full-admin page at `/admin/coverage` is a deployment inventory of evidence,
not a promise that a provider covers every place in a region. It helps answer
whether a configured operation has a published, regionally qualified and
currently usable data source, and which fact needs attention when it does not.

## Reading the page

The region matrix always shows six domain columns:

- Addresses — forward address search and reverse geocoding.
- POIs — POI search and the optional Overture enrichment stream.
- Transit — stops, departures, journey planning, and realtime.
- EV — charger discovery, charger availability, and EV route planning.
- Parking — facility discovery and occupancy.
- Traffic — flow, road conditions, and confirmed traffic-graph application.

Select a region or a domain cell to open the selected-region view. The source
table is paginated and can be filtered by domain, enabled state, attention, and
usage assessment. The selected source is preserved in the URL while its report
revision is valid, so browser refreshes and back/forward navigation do not
silently mix pages from different evidence collections.

Capability status is the result of several independent observations:

| Status      | Meaning                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Operational | A registered operation has the required evidence, regional relation, usable freshness, runtime observation, and dependency binding. |
| Limited     | It can be used with a qualification such as stale data, degraded runtime, or a partial regional overlap.                            |
| Unavailable | A required provider is disabled, unsupported, outside the selected region, expired for a live operation, or excluded by policy.     |
| Unknown     | A required fact has not been observed, is invalid, or cannot be joined to a qualified source.                                       |

The **Attention** filter includes stale or expired streams, failed attempts,
unverified region/version associations, and rights requiring attention under
the selected usage assessment. Capability blockers appear in the separate
capability table. It does not turn an empty result into a
failure: a successful empty observation is shown as a valid empty result.

## Timestamp meanings

Dates are rendered with the browser's timezone and a timezone abbreviation.
They are not interchangeable:

| Clock                        | Meaning                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Collection time              | When the bounded evidence collector assembled the report. It says nothing about the age of the underlying data.                       |
| Last attempt                 | The latest fetch, validation, import, or write attempt, including failures and skips. It never proves publication.                    |
| Last successful check        | When the active version was successfully checked. A version/hash association is required for a source to become current.              |
| Last published               | When the currently recorded artifact or cache snapshot was made active. A later failed attempt does not erase it.                     |
| Upstream as-of               | The source's own content clock, when supplied. A successful poll can still contain old upstream observations.                         |
| Expires / freshness deadline | The next validity boundary derived from the source policy or actual live TTL. At the boundary, `now >= deadline` is stale or expired. |

Static and live streams are shown independently. For example, a successful
static POI swap can remain current when the following live write fails. A live
write is only published after its durable Postgres intent is resolved against a
validated Redis multi-command result; an unresolved newer intent makes the
association unknown rather than borrowing an older success.

## Geographic evidence

The report uses matching extract/country keys first, then declared or published
bounds. Different keys do not prove disjointness: extracts can nest or overlap.
Named source scopes make declared POI bounds selectable; declared coverage alone
qualifies an otherwise usable capability as limited. Relations are **exact**, **contains**, **partial overlap**,
**outside**, or **unknown**. A provider declaration such as “worldwide” is not
treated as publication evidence. A bounding box that overlaps a small part of a
region does not prove full-region or local-count coverage, and sources without a
verified association appear in the unassigned count.

Search and Overture are singleton active regions. The collector reads stored
publication fingerprints and timestamps; it does not hash a large PBF from a
GET request. Overture's Places publication timestamp is independent of later
OSM conflation. The Places publication marker is created atomically with the active schema.

Transit evidence comes from the active MOTIS slot and manifest. Historical feed
rows do not count as active coverage, and an import timestamp is not a claim
that the schedule is valid for a particular service date. Traffic keeps flow,
conditions, and graph application as separate observations. A conditions feed
can be present while traffic-aware routing remains unverified until a graph
write is observed and associated with the active graph. Graph identity is not
yet available from the sidecar, so traffic-aware routing remains unverified. The historical sidecar survives a restart but never restores
the runtime set of applied condition IDs.

## Usage rights and provenance

The usage selector is view-only. It assesses commercial use, source-data
redistribution, and derived-data redistribution from qualified
`integrationId:sourceId` records. Missing, conditional, conflicting, or
ambiguous rights stay visible as **Review required** or **Conditions apply**;
the page never infers unrestricted permission from a provider display name.
Terms and licence links are limited to credential-free HTTP(S) URLs. Usage
conditions and a review timestamp are shown in the source drawer when the
manifest provides them.

Runtime status is passive. The page reads the existing scheduled health result
and circuit observation without probing the provider or changing cooldown
state. A provider that has not been observed recently is unknown even if it is
enabled, and an unavailable health store is reported as a partial authority.

## Collection and revision behavior

Data Manager exposes one bounded, immutable evidence snapshot. The API reads
that snapshot with a short timeout and bounded pages, then evaluates it at the
response time. A partial authority is labeled; total evidence loss returns an
unavailable response. Reports and source details are private and `no-store`,
and every endpoint requires a full-admin session.

Snapshots expire after roughly 30 seconds. If a later page or a source drawer
requests an expired revision, the API returns `snapshot_expired` and the page
starts a new report. The attention view also pins its membership: if a source
crosses a freshness or health deadline and the set of attention rows would
change, the current revision is rejected rather than returning a mixed list.
The page polls only while visible and schedules a refresh at the nearest known
validity deadline.

## Troubleshooting

Start with the reason text and the authority row, then follow the corrective
link in the source drawer:

- **No publication evidence / unknown** — inspect the relevant data workflow
  and wait for a successful active publication. Timestamp/hash columns without
  the new publication marker do not establish freshness.
- **Failed attempt with an older publication** — repair the upstream feed or
  credentials in POI ingest, Transit, or the owning integration. The older
  publication is intentionally still shown until a replacement is committed.
- **Region unknown or partial** — check the active extract, published region,
  source declaration, or provider mapping. Do not use the count as a claim of
  local completeness.
- **Traffic conditions present but routing unverified** — inspect the
  data-manager traffic cycle and graph-application counts. Conditions alone do
  not clear the router's fallback path.
- **Rights review required** — add or correct the source's manifest metadata,
  including the qualified source ID and terms/licence URLs. This page does not
  certify a deployment's legal position.
- **Collector partial or unavailable** — inspect the Data Manager and Postgres
  authorities. A corrupt local inventory is reported as corruption rather than
  a valid empty deployment; fixing the underlying workflow lets a later read
  replace the diagnostic.

The page is intentionally diagnostic and read-only. Use the linked POI ingest,
Transit, integration, or data-workflow screens for changes.
