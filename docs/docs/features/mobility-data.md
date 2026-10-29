---
title: Mobility and live data
description: Find charging, fuel, parking, shared vehicles, webcams, and current road information.
sidebar_position: 9
---

# Mobility and live data

OpenMapX can show places and vehicles with current information, such as charger
availability, fuel prices, parking occupancy, or available shared bikes. The
sources enabled by the instance operator determine coverage and which categories
appear. A location without a live value is not a promise of availability.

## Find a service nearby {/* #what-you-get */}

Choose a category in the bar above the map to search the visible area. Select a
marker to open its details. After moving the map, use **Search this area** to
request results for the new view.

| Category     | Available details depend on the source                                             |
| ------------ | ---------------------------------------------------------------------------------- |
| EV charging  | Connectors, power, operational status, tariffs, and live charge-point availability |
| Fuel         | Station information and prices by fuel grade                                       |
| Parking      | Facilities, Park & Ride sites, and free-space counts                               |
| Bike sharing | Docked or free-floating bikes, available bikes, and free docks                     |
| Car sharing  | Stations or vehicles, availability, and published pricing                          |
| E-scooters   | Available vehicles and operator no-ride, no-parking, or slow zones                 |
| Webcams      | Traffic or scenic still images and, where offered, video                           |

An open panel uses the same [place information](./places.md) as other map
results, with additional details for that category. Filters depend on the
selected source; charging can expose connector, speed, or available-now filters,
for example.

A webcam can have several views. Stills refresh while the panel is open;
external streams and players load only after you allow external media. Offline
or outdated cameras appear dimmed. External media has a different privacy
boundary from an image fetched through the OpenMapX API.

## Read road information

The [Road conditions overlay](./map-layers.md) includes information about the
road itself, alongside incidents:

- Message signs show their current pages and publication time. A blank or failed
  sign is marked accordingly.
- Road-weather stations show available surface and air observations. Check the
  measurement time and any offline, stale, or suspected-fault notice.
- Maintenance vehicles can show their current task and a short recent trail.
  Coverage and reporting frequency depend on the source.
- Border crossings can show queues by direction and vehicle class, with reported
  waiting times, open lanes, and observation times.

Use each layer's legend to interpret its symbols. A missing observation, an
empty viewport, and a source failure are different states; none establishes
that a road is clear or a service is available.

## Sources and freshness {/* #how-it-works */}

A category can combine several providers. Results carry source credits and
freshness information so you can check who supplied a value and when it was
reported. The displayed source time can differ from the time OpenMapX fetched
the response. Cached or delayed observations can remain useful, but should not
be read as a live guarantee.

### Where the data lives

Shared-mobility integrations use feeds such as GBFS and regional operator APIs.
Charging, fuel, parking, cameras, message signs, road weather, maintenance
vehicles, and border crossings can be supplied by
[OpenConditions](../administration/community-extensions.md#example-openconditions).
OpenConditions ingests and links its own datasets; OpenMapX reads its provider
responses for the requested area.

### Available sources {/* #the-built-in-sources */}

There is no single worldwide coverage guarantee. Sources differ by country,
operator, licence, credentials, and whether they publish locations, live values,
or both. OpenStreetMap-backed location data does not by itself provide live
availability or prices.

Check the credits on a result and the instance's privacy information for the
sources actually in use. OpenConditions' feed catalogue is the detailed inventory
for its datasets. For freshness and coverage diagnostics, operators should use
[Coverage and freshness](../administration/coverage-freshness.md).

## Enabling and configuring

Operators manage categories and providers in
[Admin → Integrations](../administration/integrations-administration.md).
The category integration and its provider must both be available. For example,
the charging and fuel categories are unavailable when they have no registered
site provider; enabling their UI integration alone does not supply data.

To use OpenConditions, install and configure its companion services and the
built-in adapter as described in
[Community extensions](../administration/community-extensions.md#example-openconditions).
Configure upstream ingest credentials on the OpenConditions service that owns
those feeds. Restricted sources additionally need the
[operator token](../administration/community-extensions.md#the-operator-token)
on both sides. A token controls access; it does not grant additional data rights.

Provider acquisition follows source policy and attribution requirements. The
backend provider requests normally pass through OpenMapX's server. External
links and consented media players contact their destination directly.

Developers adding a category or provider should read
[Data-source integrations](../developer/data-source-integrations.md) for search,
detail, filtering, attribution, and freshness contracts.

## Related features

- [Map layers](./map-layers.md): road conditions and other whole-map overlays.
- [Directions](./directions.md): plan a trip to a charger, parking site, or station.
- [Public transit](./public-transit.md): journeys, departures, and live vehicles.
- [Vehicles and parking](./vehicles-and-parking.md): your own vehicles and parked locations.
