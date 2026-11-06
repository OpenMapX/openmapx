# Shared travel plans: resolve and select a normal provider trip

Date: 2026-11-06. Status: revised after the user's clarification; reviewed by
Claude Opus. Corrections below are accepted for implementation. This replaces the earlier fixed-import design.

## Required outcome

Sharing a DB Navigator connection identifies and opens the exact corresponding
OpenMapX connection as though the user had searched for it and selected it in the
ordinary directions panel. DB text supplies an identity fingerprint only. All
visible trip data, including names, times, platforms, intermediate stops, alerts,
geometry, transfers and fares where available, comes from the configured transit
provider through the normal OpenMapX mapping path. An instance using Transitous
uses Transitous data; a local MOTIS instance uses that instance's data and policy.

There is no import detail screen, source banner, snapshot mode, schematic-route
notice or special alternatives action. The existing native intake confirmation,
progress/error feedback and ordinary directions controls are sufficient. Do not
render the DB text as trip detail data. No automatic navigation start.

The user's Bahn-App example is a behavioral reference. Its internal implementation
has not been established and is not assumed to use MOTIS. No emulator observation
is claimed.

## Keep and remove

Keep the pure source adapter registry and explicit plan model, German DB parser,
all four shared fixtures, overnight/calendar validation, bounded station identity
matching and iOS preservation of repeated text and URL attachment ordering.

Remove client-side `TripItinerary` composition, geometry acquisition/fallback,
`importedTransitTrip`, the fixed-import planner bypass, source notices, train
summary presentation and dedicated alternatives action. Replace their tests with
normal provider-result equivalence and ordinary directions-selection tests. The
previous screenshots and full-suite run are historical evidence, not validation
of the revised feature. The old portable run was stopped on this clarification;
it had seven failures in unchanged build-artifact tests and no final summary.

## Identity and source abstraction

`SharedTravelPlan` contains only source identification and explicit station,
service/train-number and dated wall-clock hints. Parsing remains pure, with no DB
URL fetch or new upstream. Another sharing app adds one adapter and fixtures;
it reuses resolution and publication.

Retain the 4096 UTF-16 / 8192-byte text bounds, 1..8 rail legs, 72-hour maximum,
strict complete blocks, explicit year, weekday/calendar checks, overnight date
rollover and station locality qualifiers. DB booking URLs alone cannot identify
a provider trip. Missing-year/walking/+day variants remain unsupported. Berlin
wall times are independent of device timezone; reject DST folds/gaps and endpoints
with different UTC offsets. Platforms and live delays are not identity.

## Resolve a provider result, never synthesize displayed trip data

A common resolver returns a complete `MobilityEnvelope<TripPlan>`, the exact normal
planning request and the selected itinerary identity/index. It never returns a
hand-assembled itinerary. All acquisition uses the configured OpenMapX API client.

1. Resolve geographically corroborated station names with the existing bounded
   search/nearby approach. Use the enabled provider and its current capabilities. Prefer verified boarding
   and alighting platform coordinates over parent-station coordinates; allow a
   small bounded departure margin for normal access walking.
2. Obtain dated-board and vehicle-journey identity evidence first: normal plans
   do not consistently expose operational train numbers. Bound colocated station
   aliases to 32 and candidate journeys to four per leg; deduplicate explicit
   parent/platform records. Transitous can omit parent links and expose more than
   four platform/feed aliases for one station. Verify the operational number,
   scheduled departure and arrival, ordered stop IDs and geographic station match.
3. Search through the ordinary transit planning API with an explicit departure
   anchor and canonical request options. Match the entire ordered transit sequence
   to the verified provider references. Retain walking transfers and all provider
   fields verbatim. Use at most one signed next page for discovery; if it contains
   a match, run a fresh unpaged request at that itinerary's start minute. Only an
   exact unpaged response can seed ordinary search. Never seed paged data under
   an unpaged key or choose a first/approximate alternative. One retry with the
   existing train mode group remains a real, refetchable search. Pareto planning
   can omit a valid overtaken or canceled train, so reconstruction is a fallback.
4. Ask that same provider to reconstruct the verified sequence through a common
   optional `resolveTrip` provider operation. The client submits provider-qualified
   trip/stop IDs, scheduled instants and the dataset epoch, not coordinates or
   displayed DB data. The server independently fetches provider trip data to
   obtain coordinates, native display name and scheduled/additional-trip flags. All legs must
   belong to the same provider instance/dataset context. Providers lacking reconstruction may
   succeed through normal search after dated identity discovery; missing required
   discovery support fails closed.
5. Validate the returned provider itinerary against every verified transit leg
   again. Native reconstruction can pick another candidate or return dummy legs;
   reject substitutions, changed scheduled identity and missing trip IDs. Return
   only the complete normal provider result, or keep the share unopened.

The 60-second overall deadline, cancellation, sequential bounded calls, fresh and
complete exact evidence, and authority/lifetime fences remain. Search discovery
may be partial; a matched itinerary and identity evidence must not be partial or
stale. No cross-provider concatenation, invented walks, fares, refresh handles or
geometry.

## MOTIS / Transitous reconstruction

The installed client is MOTIS 2.11.4. Its documented structured
`refreshItineraryPost` accepts an `ItineraryId` containing `LegId` references and
returns the provider's ordinary `Itinerary`. This avoids encoding a private
protobuf ID in OpenMapX. Use the existing configured MOTIS client and source
policy for local/hosted requests.

Construct transit references only from verified provider IDs, coordinates and
scheduled instants. Insert WALK transfer references between different trains:
adjacent transit references are treated as interlining by MOTIS. These are
reconstruction requests, not displayed or measured transfer legs. MOTIS resolves
the real footpath; reject dummy/unresolved transfers rather than display a guessed
path. Validate the complete returned transit identity because MOTIS reconstruction
uses candidate scoring and can substitute a nearby/time-similar trip.

Use the same `mapItinerary` / `mapLeg` normalization as ordinary planning. Preserve
provider itinerary ID, source, instance, dataset epoch, detailed legs, current
platforms, cancellations, alternatives, walking transfers and contributor receipts.
An original normal plan match retains its fares and paging in the search path;
a reconstruction is never merged into or labeled as an ordinary search result. MOTIS 2.11.4 reconstruction itself does not compute fares; do not manufacture
them or claim that the upstream supplies fields it omits. Reuse ordinary
server refresh-token eligibility and signing. A reference-based refresh must
refresh/re-resolve that exact reference or fail; it must never use the existing
search fallback that chooses `itineraries[0]`. The native returned ID is the
provider-serialized reference ID, not a planner-issued ID.

Primary contract/source evidence:

- [Pinned MOTIS API](https://github.com/motis-project/motis/blob/v2.11.4/openapi.yaml)
- [Structured refresh endpoint](https://github.com/motis-project/motis/blob/v2.11.4/src/endpoints/refresh_itinerary.cc)
- [Reconstruction and identity behavior](https://github.com/motis-project/motis/blob/v2.11.4/src/itinerary_id.cc)

## Normal directions publication

Publish only after the existing Open confirmation, final native inbox/authority
check, current document/item checks and abort checks. No await between the final
check and synchronous publication; acknowledge only afterward.

There are two truthful query inputs feeding the same existing directions UI:

- **Search match:** the unchanged complete envelope from a real unpaged `/plan`
  request. Seed it under that exact request's ordinary query key. The normal
  search query, paging and refresh behavior consume it.
- **Provider-reference match:** a separate `transit-plan-reference` query calls
  `/plan/resolve` with the verified reference. Seed only that key. Refetch calls
  the same resolver and therefore cannot replace the trip with a Pareto search
  alternative. It has no search paging. The reference is a normal provider lookup
  input, not DB metadata or a frozen snapshot; it is released by routing edits or
  closing directions. Both variants return the same complete provider plan type.

This is the explicit B1 decision: keep native reconstruction, using Opus's
provider-reference query correction rather than postponing exact-trip support.
There is no imported banner, synthesized data or permanent fixed-import bypass.

Extract one canonical builder for normal query keys and `fetchTransitPlan`
parameters. Share the capabilities query key/options so intake obtains the same
metadata the panel reads. Preserve persisted `bikeHillPreference` and the user's
`wheelchairRequired`. Reset only session exclusionary controls for this search:
preferred transport classes (or a deliberate class-restricted retry), D-ticket,
maximum transfers, route preference, access mode and transfer buffer. Preserve
other mandatory accessibility/transport requirements or fail rather than silently
ignore them. Published departure `Date.toISOString()` must equal the canonical
request anchor, including milliseconds. Do not add waypoint schedules.

Move transit time mode into the directions store so a mounted panel immediately
uses depart mode; preserve ordinary close/reset behavior. Use a generic one-shot
`pendingTransitSelection: {requestKey, itineraryKey}` handoff set atomically with
provider-labeled waypoints, query input and `isOpen`. Move the existing stable
`itineraryKey` helper from `transitPlanPages.ts` to core. The publication effect
must wait until its current query key equals the requested key, publish the normal
ranked records, find the selected identity, set active index and signal existing
details. This fences old in-flight results and the 500ms debounce without bypassing
normal query behavior. A raw-input key mismatch means a real edit/epoch change:
clear pending state and resume the ordinary flow. Clear on routing edits/close.
Do not broaden ordinary selection persistence or repair unrelated refetch UI.

Capture the origin waypoint ID before requesting auto-location. Apply its delayed
fix only when the same waypoint still exists with `coords === null`. This generic
rule preserves explicit origins for shares and ordinary route openings.

Test an already-mounted panel, old in-flight queries, debounce, synchronous cached
capabilities, raw-key mismatch, re-ranking, selection/details, ordinary paging and
focus/refetch parity. Reference refetch must retain the reference identity. No
special success UI or DB-derived endpoint display fields.

## Reconstruction contract details

Validate raw MOTIS output before `mapItinerary`: a dummy transit reference lacks
`tripId`; a dummy non-transit leg sets leg-level `cancelled === true`. A genuinely
cancelled train with the exact ID is valid. Require exact raw trip/stop IDs and both
scheduled instants for every transit reference. Obtain the provider's actual native
display name and use `requireDisplayNameMatch=true`. Use platform coordinates from
the server-fetched provider trip. Preserve the scheduled/additional-trip flag; if
not known, fail closed. Same-stop transfers and interlined number changes require
real native verification; unsupported/dummy results fail closed.

The generated POST client type omits query fields although the server supports
them. Test that detailed legs/transfers, display-name matching and interlining
options are actually serialized. Reuse the normal normalizer; never accept its
straight-line fallback after an unresolved raw reference.

Add an explicit optional resolve capability. Local support is tied to the pinned
MOTIS runtime and current dataset epoch. Hosted Transitous is unpinned: feature-
detect structured reconstruction through the configured provider transport,
otherwise return unsupported; do not assert support based only on the client
package version. Normal search matching remains available independently. Reject
mixed prefixes, stale/missing required local epoch, more than eight references and
arbitrary client coordinates. Keep health/source-policy gating and bounded calls.
Register a literal API method/path, match `/plan` authentication, regenerate
OpenAPI and inspect client-visible fields for response serialization losses.

## Minimal intake presentation

Reuse the existing confirmation dialog, Open/Later/error controls and generic
loading feedback. Later/dismissal can cancel resolution without adding a button. A recognized
travel plan can use a generic shared-trip label. Do not add a DB train summary or
render raw DB text as trip details. Existing unsupported/missing-text error feedback
may explain that the full share is required. No new success surface or persistent
source styling. Existing map/file sharing and native navigation authority remain.

## Validation and review

Before implementation, Claude Opus reviews this revised design and plan. The root
agent implements and fixes findings; Opus reviews the revised implementation before
PR creation. No user questions or approval checkpoint.

Tests must prove object/data equivalence to normal provider planning, including
fields deliberately different from the DB share (platform, delay, names, alerts,
fares, walking transfer, geometry, refresh metadata). Cover all four examples,
no Pareto match -> provider reconstruction, wrong reconstruction/dummy rejection,
unsupported sources, ambiguity, bounds, cancellation and native authority races.
The success view must be the actual existing directions details, with production
theme/font and no import banner or DB summary. Old visual evidence is replaced.
Run focused checks, affected types, full local gates and relevant native/mobile
checks; report failures and actual device/live-provider limits precisely.

## Revised Opus review disposition

B1: accepted distinct reference query, no fabricated search-cache entry, no paging
or first-result replan fallback for reconstruction. B2: only unpaged search results
may seed search; one discovery page followed by a canonical unpaged query, platform
coordinates and access margin. B3/B4: store-owned transit time mode, generic pending
selection keyed by canonical request and stable itinerary identity; matching epoch,
filters, exact anchor and persisted hill preference. I1/I2: raw/debounced key fence
and waypoint-ID/empty-origin geolocation guard. I3: retain wheelchair and mandatory
requirements; session-only neutral filter reset. I4: raw dummy/substitution checks,
real native flags/display name and POST query serialization tests; same-stop and
interlined native cases fail closed. I5: server derives coordinates/raw hints,
provider/epoch binding, honest hosted capability detection and API contract checks.
I6: missing plan numbers trigger provider-ID discovery, never route-name guessing.
Do not extend this work into ordinary refetch-selection bugs or upstream refresh
fare behavior. The reviewed reconstruction deferral recommendation is declined:
its explicit reference-query alternative is accepted to cover exact omitted trips.

## Implementation review disposition

Claude Opus reviewed the revised working tree and found no blocking exact-trip,
source-policy or publication defect. Root fixed the supported edge cases:
request-specific native 404s no longer disable reconstruction; explicit 405/501
unsupported results retain their typed 501 semantics without cooling down other
provider operations. Dated-board health cooldown is 503 rather than unsupported.
A mandatory bike-carriage session is kept with an existing-alert explanation before
acquisition, because a walking-access handoff cannot make that requirement hidden.
Successful reconstruction uses a 30-second host cache after current policy/health/
epoch checks, cloning the result before attaching independent one-time handles.
The ordinary search panel's existing index-based behavior after later refetches is
unchanged; reference lookups and reference refreshes remain bound to the same trip.
Hosted capability metadata deliberately advertises only verified runtime support.
