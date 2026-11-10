---
title: Vehicles and parking
description: Manage your vehicles and save a current parked location on this device or account.
sidebar_position: 12
---

# Vehicles and parking

OpenMapX can remember a small set of your vehicles and where each one is parked.

## Vehicles

Settings → Vehicles holds up to 12 vehicles. Each has a name, unique among your
vehicles (saving a second vehicle under a name already in use is refused with a
message), a type (car,
motorcycle, bicycle) and a powertrain. Electric and plug-in-hybrid vehicles carry
battery size, consumption, maximum DC/AC power, and connectors. You can seed these from a model in the bundled open-ev-data table and then adjust.
Petrol, diesel, and hybrid vehicles can record fuel consumption in litres per
100 km, up to 60 L/100 km. The first vehicle you create automatically becomes
the default; deleting the default vehicle automatically promotes your oldest
remaining vehicle.

EV trip planning reads this list directly: the vehicle picker in Directions shows
your garage above the built-in model dataset.

Signed in, your vehicles and parked locations sync across devices. Signed out, they are stored only in this browser.
On the first sign-in for an account in this browser, local vehicles are merged
with the account's garage. An existing account vehicle with the same normalized
name wins. Local parked locations keep their imported vehicle association;
unassigned pins stay unassigned. Existing account pins take precedence. A failed
import retains local data so it can be retried.

## Parking

Save where you parked from three places, all of them a deliberate press:

- right-click (or the context key) on the map → **Save parking here**; on a phone,
  long-press the map → **Save parking**
- tap the blue location dot → **Save parking**
- the arrival card after driving or motorcycling → **Save parking**

The pin then stays on the map until you clear it. In addition, the main **Hamburger
menu** displays a persistent **Parked vehicle** entry with elapsed parking time or
an expiry countdown. Tapping either opens the parking panel, where you can get
walking directions back to it, share its coordinates, add a note (up to 500 characters),
record when parking expires (up to 30 days ahead), move the pin, or clear it. Moving or dragging the pin clears the old address so it is not shown at the new
location.

## Parking near your destination

After a drive or motorcycle trip, the arrival card suggests up to four car parks
within 500 m of the destination. **Drive here** routes you to one, and on
arrival there the card offers the walk to your original destination.

The card leaves out car parks you cannot use now: closed ones, ones outside
their opening hours, ones for permit holders, residents or other private users,
and car parks whose every space is kept for a group, such as a single disabled
bay. A car park that only
customers may use is marked **Customers only**. Each suggestion shows whether it
is free or paid and, where the source counts them, its free spaces.

The closest six are then measured: the drive from where you stopped to the car
park, and the walk from it to your destination. The quickest drive and walk
together comes first, and the card shows the walk instead of the straight-line
distance. A car park no route reaches is left out, and one reported full comes
after the others. Until the routes are measured, or when they cannot be, the
card orders the car parks by straight-line distance.

When the instance offers the parking data source, the suggestions come from
it, with live free-space counts and access details. Without that source, or
when it does not answer, the card uses the mapped parking places from the
place search, which carries no live counts and lists only named car parks.

## What OpenMapX does not do here

Saving requires an explicit action. Motion, Bluetooth, and arrival heuristics do
not record parking automatically, and walking/cycling arrivals do not prompt.
There is one current record per vehicle, not a parking history. Saving replaces
it, clearing removes it, and deleting a vehicle removes its associated pin.

The expiry countdown is an in-app reminder. It does not send a push notification
when parking expires.

## How the data is protected

Signed-in vehicles and parking are stored in this instance's PostgreSQL
database. Private API responses are marked `no-store`. Use HTTPS for transport
protection; disk and database encryption depend on the deployment.

Saved-list exports and managed share payloads do not automatically include your
parking record. The parking panel's **Share** action deliberately creates a
location link containing its coordinates. Anyone receiving that link can read
the location.

They are **not** end-to-end encrypted: an operator with database access can read
them. See the [user-data trust model](../developer/user-data-trust-model.md). Do not treat a
parked position as secret from the instance operator. Existing database backups
may retain deleted vehicle or parking rows until the backup-retention period
expires.
