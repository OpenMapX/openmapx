# Transit navigation — scenarios that need a physical device

Everything here is **unverified**. Automated traces prove the engine, the token
discipline, the persistence and the effect ordering. None of them prove what a
phone does in a tunnel, in a pocket, on a platform in the rain.

A scenario becomes verified only when a named volunteer reports it from a
physical device against an exact beta artifact, with the device, OS version and
build recorded. Nothing here may be marked verified from a simulator run, an
emulator screenshot or a code review.

**Sanitisation rule for reports:** no trip ids, no stop names, no times precise
enough to identify a service, no coordinates. Record the *shape* — "leg 2, ride,
six stops, twelve-minute gap" — and the outcome.

## What the automated suite already settles

- one committed revision per tick, and revisions strictly increasing;
- a leg index that never moves backwards;
- schedule fallback advancing the leg with no position at all, labelled as
  schedule rather than GPS;
- no duplicate cue when the coordinator and its prepared index are rebuilt
  between every tick;
- the rotating token never appearing in a snapshot, an outbox row, a diagnostic
  or an error;
- an ambiguous refresh timeout breaking the chain rather than gambling the token;
- a replacement itinerary adopted whole, with its own token and a reset leg;
- complete storage cleanup after a stop.

## Underground and gaps

| # | Scenario | Expected | Status |
| --- | --- | --- | --- |
| U-1 | Ride an underground line end to end | Leg advances from the schedule; confidence reads `schedule`, never `gps` | unverified |
| U-2 | Emerge from underground mid-leg | First real fix reanchors without a leg jump | unverified |
| U-3 | 20-minute gap, then a fix far along the line | No backwards jump, no phantom missed connection | unverified |
| U-4 | Deep station with no signal on the platform | Boarding is detected or honestly reported as unknown | unverified |

## Alighting alert

This is the case that matters most: missing a stop is the transit failure a
rider cannot quickly recover from.

| # | Scenario | Expected | Status |
| --- | --- | --- | --- |
| A-1 | Alert fires with the phone locked and the app suspended | Delivered within the requested window | unverified |
| A-2 | Live delay shifts the alighting time | One rescheduled alert, not two | unverified |
| A-3 | Alert after a force-stop | Still delivered — the OS holds it, not this app | unverified |
| A-4 | Stop navigation before the alert is due | No alert fires | unverified |
| A-5 | Replan while an alert is scheduled | Old alert cancelled before a new one is scheduled | unverified |
| A-6 | Notification permission declined | Navigation runs; the page reports the backup unavailable | unverified |
| A-7 | Alert alongside a spoken cue for the same moment | Not experienced as a double announcement | unverified |
| A-8 | Do Not Disturb / focus mode | Behaviour recorded per platform; not assumed | unverified |

## Live data and replanning

| # | Scenario | Expected | Status |
| --- | --- | --- | --- |
| L-1 | Refresh across a 40-minute ride | Times track; token rotates; no duplicate consumption | unverified |
| L-2 | Refresh times out ambiguously | Chain marked broken; recovery via replan, not a retry | unverified |
| L-3 | Platform change mid-journey | Announced once, under one event | unverified |
| L-4 | Cancellation of an upcoming leg | One replan; captured trip stays active until it commits | unverified |
| L-5 | Missed connection | One replan; rider is not left with a plan they cannot make | unverified |
| L-6 | Offline for the whole journey | Captured itinerary and stop counts continue; nothing invented | unverified |
| L-7 | Reconnect after a long offline stretch | Exactly one refresh or replan, never both racing | unverified |

## Audio

| # | Scenario | Expected | Status |
| --- | --- | --- | --- |
| S-1 | Board, alight and transfer cues with the screen locked | Audible and correctly ordered | unverified |
| S-2 | Cue while music plays | Ducks and resumes | unverified |
| S-3 | Cue over Bluetooth | Routed to the device; recorded per headset | unverified |
| S-4 | German journey end to end | Every cue in German, correctly formed | unverified |

## Lifecycle

| # | Scenario | Expected | Status |
| --- | --- | --- | --- |
| C-1 | WebView reload mid-journey | Native session and stream unaffected | unverified |
| C-2 | Process recreation under memory pressure | Session recovered; one stream; token intact | unverified |
| C-3 | Force-stop, then relaunch | Resume or End offered; nothing restarts on its own | unverified |
| C-4 | OEM battery management (Xiaomi, Huawei, Samsung, OnePlus) | Recorded per device; failures expected to differ by vendor | unverified |

## What is explicitly not claimed

**Station-level underground precision.** Confidence is reported as `gps`,
`schedule` or `stale`, and a schedule-driven leg advance is never presented as a
physical observation. No store text, review note or beta instruction may imply
the app knows which underground station the rider is at without a position fix.

## What a failure here means

A duplicate token consumption, a duplicate cue or notification, a leg regression
or jump, an alert surviving a stop or replan, a captured itinerary lost while
offline, or a mutation after stop — any of these blocks public release. If the
failure is specific to the location driver rather than to transit logic, it feeds
the same driver-qualification decision as the ground scenarios.
