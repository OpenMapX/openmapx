---
sidebar_position: 12
---

# Vehicles and parking

OpenMapX can remember a small set of your vehicles and where each one is parked.

## Vehicles

Settings → Vehicles holds up to 12 vehicles. Each has a name, a type (car,
motorcycle, bicycle) and a powertrain. Electric and plug-in-hybrid vehicles carry
a battery spec — battery size, consumption, maximum DC and AC power, connectors —
which you can seed from a model in the bundled open-ev-data table and then adjust.
One vehicle is the default; that is the one route planning and parking use unless
you pick another.

EV trip planning reads this list directly: the vehicle picker in Directions shows
your garage above the built-in model dataset.

Signed in, your vehicles sync across devices. Signed out, they are stored only in
this browser. Signing in for the first time uploads what the browser held; a
vehicle whose name already exists on the account is kept as the account has it.

## Parking

Save where you parked from three places, all of them a deliberate press:

- right-click (or the context key) on the map → **Save parking here**
- tap the blue location dot → **Save parking**
- the arrival card after driving or riding → **Save parking**

The pin then stays on the map until you clear it. Tapping it opens the parking
panel, where you can get directions back to it, share it, add a note, record when
the parking expires, move the pin, or clear it.

## What OpenMapX does not do here

- **No automatic detection.** Nothing is recorded unless you press a button.
  There is no motion, Bluetooth, or arrival heuristic.
- **No history.** There is one current record per vehicle. Saving again replaces
  it; clearing deletes it outright. Deleting a vehicle also deletes where it was
  parked.
- **No reminder.** "Parking expires" is a note to yourself with a live countdown
  in the app. OpenMapX does not send a notification when it elapses.

## How the data is protected

Vehicles and parked positions are stored in this deployment's PostgreSQL database
with the same protection as saved places: transport is TLS, at-rest protection is
whatever the deployment's disk and database encryption provide, and every request
is scoped to your account. Responses are marked `no-store`, coordinates are kept
out of application logs, and parked positions are never included in share links or
in a saved-list export.

They are **not** end-to-end encrypted: an operator with database access can read
them. Whether and how OpenMapX adopts client-side encryption for user data is
being decided separately, in the user-data trust model
([issue #312](https://github.com/OpenMapX/openmapx/issues/312)). Do not treat a
parked position as secret from the instance operator.
