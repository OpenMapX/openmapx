---
title: Offline maps and navigation
description: Download selected map coverage to this device and continue a ground route planned online.
---

# Offline maps and navigation

Download an area while online to keep its map available on this device. You can
also continue a ground route that was planned online. Offline mode does not
provide new route planning, arbitrary rerouting, live traffic, live transit,
new provider searches, or network-backed overlays.

Your instance must provide compatible self-hosted map data and use the OpenMapX
style. A deployment using MapTiler's complete hosted style cannot prepare these
packages. If downloading is unavailable, ask the operator to check
[the map-tile setup](../guides/map-tiles.md).

## Download an area {/* #what-a-package-contains */}

1. Sign in and open **Offline maps** in the main menu.
2. Choose **Download a new area**, find or move the map to the area, and select
   the zoom range. Give the area a name you will recognize.
3. Choose **Start download**. Preparation and download need a network connection;
   wait until the area is ready before depending on it.
4. Review the area and its coverage. Downloading a nearby region does not cover
   an entire journey or every zoom level.

Preparation has per-account and IP limits. If a request is rate-limited, wait
for the indicated retry delay. Repeatedly submitting the same area also counts
against the request limit. The server has queue and storage limits, and a large
area can need more space than the device has available.

## Manage local storage {/* #download-and-storage-guarantees */}

The offline list lets you inspect areas, resume an interrupted download where
possible, and remove areas you no longer need. A package becomes ready only
after its archive and required map assets pass validation. Missing or corrupt
local data must be downloaded again.

Downloads belong to this browser and device. They are not synchronized through
your account, and clearing site data can remove them. Signing out leaves
already-downloaded areas available locally. On a shared device, remove those
areas separately if you do not want them retained. Browser storage can be
evicted under storage pressure; use **Protect offline storage** where available
and check your areas before a trip.

### Recent map data

**Remember recent map data on this device** is an optional setting, separate from
area downloads and off by default. It can retain supported recent searches,
routes, place details, weather, photos, and nearby results, including search
text and precise map coordinates. Most entries expire within minutes to 24
hours; photo lookup caches can last up to seven days.

Cached responses do not provide fresh searches, traffic, or guaranteed coverage.
Turn the setting off to clear its retained response data, or use **Clear recent
map data** in Storage. Removing an offline area and clearing recent data are
separate actions.

### Use several areas {/* #rendering-one-or-many-areas */}

Compatible ready areas appear together on the same map, including adjacent and
overlapping downloads. The map keeps the configured OpenMapX light or dark
presentation. A package's coverage and zoom range still limit the detail
available at a particular location.

## Continue a route offline {/* #offline-navigation */}

Plan the ground route online and download the coverage you need before leaving
connectivity. OpenMapX keeps one bounded route snapshot for continuation. After
reloading, you must confirm restoration of the saved route; snapshots expire
after 24 hours.

While offline, the existing route geometry, maneuvers, progress, and voice
guidance can continue. The interface distinguishes a downloaded map from a
route line without downloaded map coverage. It does not request a new route,
live incidents, or faster-route proposals.

If you leave the route, offline mode cannot calculate an arbitrary replacement.
When connectivity returns, deliberately retry rerouting; reconnection does not
silently replace the restored route. Removing an area also removes that area's
map coverage from the continuation view.

## Sources and credits {/* #source-and-attribution-boundary */}

Packages use the instance's self-hosted OpenMapX tile and glyph inputs. They do
not download a hosted MapTiler dataset. Their credits identify their own map
data and style sources, independently of whichever hosted source the online map
uses.

Developers and operators can read [Offline map packages and route snapshots](../developer/offline-maps.md)
for preparation quotas, immutable manifests, validation, storage, and cache
boundaries. For download problems, see [Troubleshooting](../overview/troubleshooting.md#downloaded-maps-are-unavailable-offline).
