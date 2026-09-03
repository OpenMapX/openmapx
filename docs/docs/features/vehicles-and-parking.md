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
Petrol, diesel, and hybrid vehicles can record `fuelConsumptionLPer100Km` (litres
per 100 km, up to 60 L/100km). The first vehicle you create automatically becomes
the default; deleting the default vehicle automatically promotes your oldest
remaining vehicle.

EV trip planning reads this list directly: the vehicle picker in Directions shows
your garage above the built-in model dataset.

Signed in, your vehicles and parked locations sync across devices via the
`/api/garage/*` endpoints. Signed out, they are stored only in this browser.
Signing in for the first time uploads what the browser held: vehicles are merged
(keeping the account's version if a vehicle name collides), and browser parked
locations upload with `vehicleId: null` (unassigned) to cleanly link to your account.

## Parking

Save where you parked from three places, all of them a deliberate press:

- right-click (or the context key) on the map → **Save parking here**
- tap the blue location dot → **Save parking**
- the arrival card after driving or motorcycling → **Save parking**

The pin then stays on the map until you clear it. In addition, the main **Hamburger
menu** displays a persistent **Parked vehicle** entry with elapsed parking time or
an expiry countdown. Tapping either opens the parking panel, where you can get
walking directions back to it, share its coordinates, add a note (up to 500 characters),
record when parking expires (up to 30 days ahead), move the pin, or clear it. Moving
or dragging the pin explicitly clears any previously reverse-geocoded address
(`address: null`) so stale street labels are never retained.

## What OpenMapX does not do here

- **No automatic detection.** Nothing is recorded unless you press a button.
  There is no motion, Bluetooth, or arrival heuristic. Walking and cycling arrivals
  do not prompt for parking.
- **No history.** There is one current record per vehicle. Saving again replaces
  it; clearing deletes it outright. Deleting a vehicle also deletes where it was
  parked.
- **No push notification.** "Parking expires" is a note to yourself with a live countdown
  in the app. OpenMapX does not send a push notification when it elapses.

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
