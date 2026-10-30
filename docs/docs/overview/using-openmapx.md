---
title: Use the map
description: Find a place, get directions, and choose which OpenMapX features to use.
sidebar_position: 2
---

# Use the map

Open your OpenMapX instance in a browser. You can explore the map, search for
places, and plan routes without creating an account. Available providers and
coverage depend on the instance you are using.

## Find a place

1. Enter a place name, address, or coordinates in the search field.
2. Select a suggestion to move the map and open the place panel.
3. Use the panel to check the address, opening hours, photos, or other available
   details. Missing fields usually mean the source has no data for that place.

You can also select a place directly on the map. See [Search](../features/search.md)
for supported query formats and [Places](../features/places.md) for the detail
panel and category search.

## Get directions

1. Open a place and choose **Directions**, or open the directions panel.
2. Set the start and destination. Using your current location requires browser
   permission; entering a start manually works without it.
3. Choose a travel mode and review the suggested route or journey.

Read [Directions and navigation](../features/directions.md) for ground travel and
EV planning, or [Public transit](../features/public-transit.md) for stops,
departures, and journeys. Live information is available only where a configured
provider supplies it. Check the displayed times and source information when a
decision depends on freshness.

## Change the map

Use the map's layer controls to show additional information, such as transit,
weather, or street-level imagery. A layer can have limited coverage or require
an integration that the instance operator has not enabled.

[Map layers](../features/map-layers.md) describes the available overlays.
[Map framing and street alignment](../features/map-framing.md) explains how the
map adjusts around panels and how to rotate it to a street grid. Display and
navigation preferences are available from **Settings** in the main menu.

## Keep places and journeys

Sign in to keep [saved places](../features/saved-places.md), organize them into
lists, and synchronize them across devices. Open **Saved** in the main menu to
manage lists, import existing bookmarks, or export a list. Share links can make
a list readable by anyone who has the link; review its contents before sharing.

Other optional features have separate storage and setup requirements:

- [Vehicles and parking](../features/vehicles-and-parking.md) can remember your
  vehicles and current parked locations. Signed-out data stays in the browser;
  signed-in data synchronizes with your account.
- [Personal timeline](../features/personal-timeline.md) reads an existing Dawarich
  account after you connect it. OpenMapX does not collect location history for you.
- [Offline maps](../features/offline-maps.md) downloads selected coverage to this
  device. Download it while online and check that it is ready before relying on it.
  Offline support does not include planning a new route.

For sign-in, recovery, data copies, and account deletion, see
[Accounts and your data](../features/accounts-and-privacy.md).

## Install the web app

If your browser offers installation, use the install entry in the main menu or
the browser's own installation control. Installation opens OpenMapX as an app;
downloaded map coverage still needs to be prepared separately.

If a feature is unavailable, see [Troubleshooting and help](./troubleshooting.md)
before changing browser storage or reconnecting accounts.
