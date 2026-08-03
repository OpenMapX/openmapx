# Offline maps and navigation

OpenMapX remains online-first. Offline support is an explicit local capability
for selected OpenMapX coverage, not a mirror of every online service.

## Map packages

Choose an area and zoom range from **Settings → Offline maps**. The server
measures the request and creates one immutable PMTiles package from the same
self-hosted OpenMapX MBTiles dataset used by the online OpenMapX style. The
package manifest binds together:

- the rectangular coverage and zoom range;
- the dataset, style, and tile-schema versions;
- the exact archive length, checksum, and immutable ETag;
- the OpenStreetMap/OpenMapTiles attribution; and
- the versioned style, sprite, and font asset namespace.

The browser downloads the archive as a resumable byte stream. It stores package
metadata in IndexedDB and uses the Origin Private File System for the archive
when available, with a complete-blob fallback. A package is not marked ready
until its byte length, SHA-256 checksum, PMTiles header/metadata, and style
assets have been validated. The service worker caches only the app shell,
normal online runtime responses, and versioned package style assets; it is not
a per-tile offline database.

Packages are content-addressed and immutable. A new dataset or style version
creates a new package identity. Server retention limits and browser storage
controls prevent repeated refreshes from creating unbounded copies; old
packages can be deleted from the settings page.

The local MapLibre protocol reads PMTiles directly from the browser archive.
It never sends local tile reads through the network. Overlapping packages are
selected deterministically, and packages whose dataset, style, or tile schema
does not match the current map are not used.

## Offline navigation

Version one supports continuation of a ground route that was planned online:

- route geometry, maneuvers, alternatives, waypoints, options, progress, and
  package identities are kept in a bounded, schema-versioned local snapshot;
- restoring after reload always requires an explicit confirmation;
- the existing route, position, progress, voice guidance, and known maneuver
  data continue without a network;
- off-route directions requests, faster-route checks, incidents, traffic
  signals, and live alerts are suppressed while offline; and
- reconnecting does not silently replace the route. The user can deliberately
  retry a reroute once the network is available.

The route snapshot is retained for 24 hours and excludes raw GPS history,
live incidents, transient faster-route proposals, and raw API responses. The
route line and map coverage are separate states: a route can remain available
even when the current location is outside every compatible downloaded package.

Offline route planning, arbitrary offline rerouting, live traffic, live
transit, and other network-backed overlays are not provided by this version.

## Provider and attribution boundary

The default `openmapx` style uses the deployment's configured tile source. On
the OpenMapX deployment this is the same-origin self-hosted `/tiles` source,
backed by the Planetiler/OpenMapTiles MBTiles dataset. MapTiler Cloud is a
fallback source for deployments without a configured self-hosted tile source;
it is not the default provider selection and is not packaged as an OpenMapX
offline dataset.

Offline packages use the self-hosted OpenMapX lineage only. Their visible base
map credits are OpenStreetMap and OpenMapTiles; MapTiler attribution is not
added to a package that did not use MapTiler-hosted tiles.
