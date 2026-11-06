# Shared travel plans: DB Navigator exact connections

Date: 2026-11-06. Status: proposed for independent Claude Opus review.

## Intent and scope

Sharing a DB Navigator connection to the existing Android/iOS OpenMapX share
receiver should open that connection, including its individual trains and overnight
transfers. Opening an approximately similar route is a failure. The user delegated
all design decisions and implementation, requesting Opus reviews before and after
implementation; there is no additional human approval checkpoint.

The first adapter supports the German plain-text format supplied in the request:
route header, German weekday/date, repeated service / Nach / Ab / An blocks, and an
optional `Verbindung ansehen: https://www.bahn.de/buchung/start?vbid=...` footer.
The four supplied examples become regression fixtures. URL-only shares cannot
prove a connection and explain that the full connection text is needed. Recognized
but malformed plans never fall through to an ordinary map search.

No new upstream, API route, credentials, native bridge version, or dependencies.
No automatic navigation start, ticket import, booking, persistence of raw shares,
tracking, or background DB link resolution. Other languages, walking-only shares,
cross-timezone journeys and other source apps are subsequent adapters, not guessed
formats. Existing generic text, location and geometry sharing remains supported.

## Investigation and alternatives

Current flow: native owned inbox -> protocol-v4 `intake.list/read` ->
`NativeIntakeHandler` editable confirmation -> `classifySharedText` -> map URL
application -> `intake.complete`. Today a DB share is searched as text.
Native authority and document-generation fencing must remain intact.

Transit route search (`fetchTransitPlan`) returns provider-qualified stop/trip IDs,
scheduled and current leg times, service numbers, geometry and contributors. The
existing directions store/layer/cards/details/navigation already consume these
itineraries. `useTransitDirectionsPlan` would overwrite a manually inserted trip
unless explicitly suspended. `TransitDetailsView` renders individual trains.

Alternatives considered:

1. Resolve the DB vbid using DB's web/mobile APIs. This could recover richer data
   and URL-only shares but requires an undocumented, changeable external API,
   privacy/source policy, attribution and a new integration. Rejected for this
   feature. External research: the db-vendo-client maintainers document distinct
   web/mobile APIs and opaque journey reconstruction; this is not a stable
   documented cross-provider trip identifier. See
   <https://github.com/public-transport/db-vendo-client/blob/main/docs/db-apis.md>.
   A live read of the supplied bahn.de page was unavailable during investigation.
2. Run one A-to-B search and select a close result. Rejected: optimization can omit
   the specified trains/long transfer; endpoint/time similarity is not identity.
3. Parse explicit legs, resolve each through existing OpenMapX transit search,
   verify every leg, and publish a fixed imported itinerary. Selected. Per-leg
   search preserves nonoptimal transfer choices while retaining provider geometry,
   identities, current delays and attribution. Bounded search can still fail to
   find a train; report unavailable rather than substituting it.

Dated timetables plus vehicle journeys were also investigated. MOTIS timetables
stop at 300 departures and are absent on the hosted adapter. They are unsuitable
as the primary discovery mechanism for late departures at busy stations.

## Architecture

### Source adapters (pure, shared core)

Create `packages/core/src/travel-plans/` with a source-neutral model and explicit
adapter registry. An adapter has a stable id, display name and pure `parse(text)`
returning unrecognized, invalid with reason, or a normalized `SharedTravelPlan`.
The registry has one DB Navigator adapter; future adapters register here without
modifying mobile or transit resolution. No network in parsers.

A plan contains source id/label, origin/destination names and 1..8 ordered rail
legs. A leg contains station names, local departure/arrival date/time, display
service/line, train number and optional headsign/platforms. Shared platforms are
reference hints, not immutable identity (live platforms may change).

Enforce the existing 4096-character/8192-byte intake bounds before parsing; reject
control characters. Accept CRLF, blank lines, NBSP and ordinary whitespace
variants. Parse all blocks, not just recognizable subsets. Validate calendar dates,
weekday, 00:00..23:59 times, header endpoints and contiguous transfer names.
Strip only explicit `, Gleis ...` suffixes, not arbitrary commas in station names.
Increment the calendar date each time the sequence crosses midnight; impose a
72-hour maximum duration, 8-leg limit and nonzero leg durations. Service examples
`RE9 (10935)` and `ICE 1541` provide both public label and operational train number.
Do not interpret an arbitrary train label as a machine trip ID.

`classifySharedText` gains travel-plan and invalid-travel-plan outcomes before its
multiline/map heuristics. A DB vbid link alone is recognized as missing text.
An invalid recognized share is visible/editable, but cannot open as a map query.

### Resolver (shared core, injected acquisition)

`resolveSharedTravelPlan(plan, port, signal)` acquires only after the user clicks
Open. The default port uses the configured OpenMapX `ApiClient`; tests inject it.
Resolve station names through `/transit/stops/search` (limit 20), requiring exact
normalized names (Unicode/case/whitespace; no fuzzy city/station substitution).
Collapse duplicate provider records only when coordinates agree within 100 m;
multiple geographic clusters mean ambiguous, not first-result selection.

For each leg, call `fetchTransitPlan` with station coordinates, a departure anchor
15 minutes before the shared departure, `maxTransfers: 0`, `numItineraries: 6`,
walking access and no direct street modes. Use at most 2 pages per leg through
OpenMapX signed page tokens. No user route preference or Deutschlandticket filter
may exclude the shared train. Bound the whole operation to 60 seconds; cancellation
must stop acquisition and prevent publication.

Match exactly one non-street leg per candidate. Require valid coordinates,
provider trip/stop IDs, exact normalized from/to station names, exact scheduled
departure AND arrival instants, and matching operational train number from
`tripShortName` or `serviceInfo.trainNumber`. Explicit conflicting train numbers
always reject; a route line alone cannot confirm `RE9 (10935)`.
Use scheduled fields; only fall back to start/end where realtime is explicitly
false. Check service label when it is available and comparable; platforms and
headsigns are not identity because providers abbreviate/change them.

Resolve DB domestic times in Europe/Berlin, independently of the device timezone;
require resolved endpoint timezones to agree. Reject nonexistent and ambiguous
DST wall times rather than shifting or arbitrarily choosing an occurrence.
Deduplicate copies of the same provider-qualified trip/endpoints/times; distinct
matching trips are ambiguous. Finish both pages before deciding uniqueness.
Failures distinguish invalid, unavailable, not-found and ambiguous to the UI,
without logging raw input. Partial data or partial matches never publish.

Publish a `TripItinerary` containing the verified transit legs in order. Do not
invent walking legs, transfer feasibility, through-ticket fares, refresh tokens,
CO2 totals or cross-provider dataset identity. Preserve per-leg contributors,
geometry, IDs, current/scheduled times, cancellation flags and alerts. Union actual
provider contributors at itinerary level. Calculate duration, distance (when all
legs supply it) and transfers from the verified legs. Transfer gaps must remain
chronologically ordered in scheduled time; realtime disruptions can invalidate
connections and remain visible. An imported-trip notice states that station
transfer paths have not been checked. Existing navigation remains an explicit
separate action, with its existing feasibility/authority checks.

### Fixed trip presentation and lifecycle

Add an imported transit trip marker and atomic `openImportedTransitTrip` action to
the directions store. Populate station waypoints, transit mode, departure time,
exact itinerary and active index. Open the directions panel and details for the
imported itinerary. Map rendering uses the existing itinerary layer.

Suspend automatic transit planning/paging/publication while the imported trip is
active. Do not let already-running search responses replace it. When the user
edits routing inputs or closes directions, clear the imported marker and resume
ordinary planning. Show source and transfer notice, with an explicit action to
search for alternatives (clears the marker). Imported trips are transient and
cannot create a hidden persistent routing lock. Existing ordinary directions
must retain their behavior.

The intake handler classifies once per draft and displays a compact source,
station/date/train summary before confirmation. No network during preview.
Open resolves asynchronously, then repeats native inbox existence/authority and
local navigation/document-generation checks before a synchronous publication.
Fence selected item, draft and component lifetime; a changed item/draft, navigation
start, route change or unmount cannot publish stale results. Cancel pending work
on those transitions. Acknowledge only after publication; failures retain the item
and draft for retry. Reopening after an acknowledgement failure is idempotent at
the itinerary level. Existing map/file paths retain their checks.

New user-facing strings live in both en/de JSON files. No technical provider or
parser diagnostics in product UI. Errors explain that the exact connection could
not be verified, and invite retry or correcting/sharing full text; never silently
suggest that a fallback is the imported journey.

## Acceptance and verification

- All four supplied texts parse, including next-day Berlin arrival and RE1 on the
  following calendar day after ICE 1540. Browser timezone cannot change results.
- Synthetic provider fixtures resolve all four exact train sequences and preserve
  IDs, geometry, contributors, delays, cancellations and platform changes.
- Wrong train, same line, wrong service day, changed scheduled arrival, missing
  number, multiple matches, ambiguous station, partial/no data, invalid date,
  malformed/truncated extra leg, excess bounds, DST gaps/folds and URL-only shares
  do not select a different trip or generic search.
- Per-leg pagination finds a matching second-page service; caps and cancellation
  stop bounded work. A long wait does not require the whole connection to be a
  Pareto-optimal route.
- Intake tests cover no acquisition before confirmation, authority changes while
  resolving, unmount/draft/item changes, failed acknowledgement and retry.
- Store/hook tests prove imported state cannot be overwritten by stale planning,
  and explicit edits/alternatives/close release it.
- Run focused tests, affected types, translations, formatting, full `verify:full`,
  mobile tests/bundle checks appropriate to the shared navigation-barrel changes.
- Inspect actual rendered intake, imported details and failure states, including a
  narrow viewport. Attach hosted contextual screenshots to the PR and inspect
  uploads. Browser fixtures prove web presentation, not Android/iOS share-sheet
  delivery. Report native device/DB live-provider checks separately and honestly.
