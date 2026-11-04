---
title: Transit navigation
description: Rider actions, GPS progress, walking recovery and native session authority during a selected transit journey.
---

# Transit navigation

The browser and installed shell share `processTransitFix`. Its pure input is the
selected itinerary, captured board-to-alight stops, prior state, optional GPS or
rider action, and an explicit clock. The state owns the current leg, walking step
gate, ordered stop cursor, last trusted along-distance/time, cue identities and bounded
undo. Timetables do not commit physical transitions.

## Rider and service evidence

- Walking finishes inside the target area. A projected fraction alone cannot
  establish arrival. Walking steps reuse the ground navigation step gate and
  voice distance tiers. Repaired walking instructions preserve turn icons.
- Boarding and alighting require rider confirmation. Undo restores the preceding
  phase within 120 seconds. Adjacent rides require separate confirmation; an
  explicit interline continuation supports staying aboard.
- The stop cursor indexes occurrences, including repeated IDs on loops. Ordered
  geometry, sequential proximity, plausible movement and a bounded search prevent
  distant projections from skipping stops. The first aboard fix anchors progress;
  subsequent jumps require plausible movement since the last trusted update or
  two consistent corridor fixes. An unreliable projection surfaces uncertainty.
  A GPS approach alarm also requires being within 1 km of the final captured stop;
  one remaining stop alone is insufficient on a long nonstop ride.
  Scheduled departure/arrival timestamps select repeated boarding/alighting visits;
  an ambiguous scheduled match stays unavailable. Missing stops never produce invented stops.
- Fixes must have valid coordinates and accuracy at most 100 m, be no older than
  30 seconds, no more than 5 seconds ahead, ordered, and not coasted. The last
  accepted fix owns the rider marker and camera. Route projection is separate.
- Live refresh must preserve structural journey identity. Only matching captured
  stop sequences receive new predictions; the rider cursor is not reset. A changed
  selected trip is rejected, not adopted as a refresh.

## Host ownership

The browser keeps the active tick state and captures in the navigation store.
It has one location watcher and a visible-page freshness tick. A component remount
preserves progress; a full reload ends this volatile session.

Native exclusively owns location delivery, durable session state, speech, scheduled
alerts and the rotating refresh token. The page renders sanitized full/progress
snapshots, including captured stops and planning requirements. It runs no second
transit engine or token consumer. The persisted session schema is version 2; older
sessions are discarded, with no migration.

`transit.action` is bounded by the bridge schema and checked against session ID,
itinerary fingerprint, expected phase and leg. Normal GPS revision increments must
not invalidate a rider's tap. Action IDs and the durable command ledger suppress
retries. The coordinator commits before publishing or acknowledging; revisions
order snapshots. Native capabilities advertise `transitActions` so unsupported
shells cannot show apparently working controls.

Native live refresh runs outside the coordinator queue, in foreground and headless
compositions. Its result re-enters through a generation/request/session guard and
preserves current tick state. Prepared geometry and captured stop projections are
reused across storage reloads until the navigation data revision changes. The headless callback waits for its bounded remote
work to settle. A potentially spent token is not retried after ambiguity. Broken
live updates retain the selected itinerary and are visible in the read model.
Scheduled get-off backups arm only in the riding phase and are reconciled on
alight/undo. Their text identifies them as time estimates.

## Walking recovery and alternatives

`repairTransitWalk` changes only the current walking geometry, instructions and
supplier metadata, with a validated endpoint within 50 m of the selected target.
A sustained off-path position triggers bounded ground walking directions in the
visible page, with a 30-second retry interval. Native adoption uses the typed
`transit.walk-route` command and the existing committed session, preserving token,
captures and selected rides. A late result after boarding or a journey change is
discarded. Background walking recovery waits until the page is available. Because
general ground routing has no wheelchair contract, required wheelchair journeys
retain their path and direct recovery through transit alternatives instead.

Alternative queries preserve original planning requirements and destination. They
are on demand, abortable and bounded. An onboard query is a labeled preview from
the planned alight stop at its expected arrival time. Adoption requires a fresh
actual off-vehicle position, matching journey identity, and a new captured package.
Only explicit selection replaces the journey. Load failures, empty results,
dismissal and stale responses do not change the followed connection.

## Verification

Use synthetic traces for delayed departures, tunnels, geometry disagreement,
loops, repeated stops, ride-only and interlined itineraries, wrong-stop alighting,
undo, rejected fixes and process restart. Browser tests cover capture/refresh
ownership, camera release, walking repair and explicit alternative adoption.
Native SQLite-backed coordinator tests cover durable acknowledgements and identity
checks across location revisions. Render desktop and mobile states in an actual
browser; jsdom serialization does not reproduce the custom bottom sheet's layout.
Native device delivery and live-provider field travel remain separate checks.
