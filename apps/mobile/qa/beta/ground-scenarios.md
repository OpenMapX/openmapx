# Ground navigation — scenarios that need a physical device

Everything here is **unverified**. Automated traces prove the engine, the
persistence and the effect ordering; none of them prove what a phone does in a
pocket, in a tunnel, on a cold morning, with a call coming in.

A scenario becomes verified only when a named volunteer reports it from a
physical device against an exact beta artifact, with the device, OS version and
build recorded. A simulator run, a code review or an emulator screenshot is not
evidence and must not be entered here.

## What the automated suite already covers

These are settled and need no physical confirmation:

- one committed revision per batch, and revisions strictly increasing;
- progress that never regresses along a route;
- no duplicate cue, including across a process restart between every fix;
- captured-route guidance with no network at all;
- a reroute that starts from the raw fix, carries the captured avoid flags, and
  leaves the old route in place when the answer is malformed;
- bounded coasting that decelerates and stops rather than jumping;
- terminal cleanup leaving only the non-location acknowledgement.

## Driving

| # | Scenario | Expected | Status |
| --- | --- | --- | --- |
| D-1 | 30 minutes of motorway driving, screen locked | Cues arrive on time; no gap longer than the beta threshold | unverified |
| D-2 | Urban driving with tall buildings | Weak-GPS flagged; no phantom off-route; no reroute storm | unverified |
| D-3 | Tunnel of 30–120 seconds | Coasting bridges the gap, then reanchors on the first real fix | unverified |
| D-4 | Deliberate missed turn | One off-route warning, one reroute, one replacement | unverified |
| D-5 | Missed turn with no network | Captured route keeps guiding; no route is invented; reroute fires once on reconnect | unverified |
| D-6 | Arrival at destination | One arrival cue, tracking stops promptly, storage cleaned | unverified |
| D-7 | 60-minute journey, battery and thermal recorded | Numbers recorded, not judged; a regression threshold comes later | unverified |
| D-8 | Phone in a pocket, screen off, whole journey | Guidance continues; this is the single most important case | unverified |

## Walking, cycling, motorcycle

| # | Scenario | Expected | Status |
| --- | --- | --- | --- |
| M-1 | Walking route with frequent turns | Cue timing suits walking pace; arrival threshold is not premature | unverified |
| M-2 | Cycling route including a shared path | Correct profile requested; progress tracks | unverified |
| M-3 | Motorcycle route at motorway speed | Cues arrive early enough to act on | unverified |
| M-4 | Walking indoors then outdoors | Accuracy transition does not produce a false off-route | unverified |

## Audio

| # | Scenario | Expected | Status |
| --- | --- | --- | --- |
| A-1 | Cue while music plays | Music ducks, cue is audible, music resumes | unverified |
| A-2 | Cue while the screen is locked | Cue is audible | unverified |
| A-3 | Cue during a phone call | Cue skipped, never queued to play after the call | unverified |
| A-4 | Cue over Bluetooth car audio | Routed to the car; recorded per head unit | unverified |
| A-5 | Silent mode / mute switch | Behaviour recorded per platform; not assumed | unverified |
| A-6 | Voice disabled mid-journey | Speech stops at once; the engine keeps progressing | unverified |

## Lifecycle

| # | Scenario | Expected | Status |
| --- | --- | --- | --- |
| L-1 | WebView reload mid-journey | Native session and stream unaffected; page gets a full snapshot | unverified |
| L-2 | Process recreation under memory pressure | Session recovered; exactly one stream | unverified |
| L-3 | Force-stop then relaunch | Resume or End offered; nothing restarts on its own | unverified |
| L-4 | OEM battery optimisation (Xiaomi, Huawei, Samsung, OnePlus) | Recorded per device; failures expected to differ by vendor | unverified |
| L-5 | Foreground-only grant, app backgrounded | Guidance pauses immediately, resumes on return | unverified |

## What a failure here means

A gap that makes essential guidance unreliable is a **location-driver
qualification failure**, not permission to add an unproven background timer. If
the same driver-specific background-survival, delivery-gap, duplicate-stream or
teardown failure reproduces **twice** on the same beta build, the narrow native
`LocationDriver` fallback is activated — and only the driver is replaced.

An audio, WebView, configuration or navigation-engine failure is fixed in its own
subsystem and does not justify replacing the location module.

Any of these blocks Plan 05 integration if it appears in the automated suite
instead: a duplicate cue, a progress regression, a mutation after stop, a route
lost while offline, or a stale reroute result resurrecting a session.
