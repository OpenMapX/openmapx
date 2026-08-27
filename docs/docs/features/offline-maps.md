---
title: Offline maps and navigation
description: Download OpenMapX coverage and continue an existing ground route without a network.
---

# Offline maps and navigation

OpenMapX is online-first. Offline support is an explicit local capability for
selected OpenMapX coverage, not a mirror of search, routing, live traffic, or
every overlay.

## What a package contains

Choose bounds and a zoom range in **Settings → Offline maps**. The data-manager
extracts an immutable PMTiles archive from the deployment's OpenMapTiles-schema
MBTiles source. The browser also pins the versioned glyph PBFs required by the
configured OpenMapX light and dark styles.

Preparing a new area and checking its preparation status require a signed-in
OpenMapX session. Already-downloaded areas remain visible, removable, and usable
on the device after sign-out. Capability discovery, immutable manifests, glyphs,
and content-addressed archive downloads remain public so an issued download URL
can finish without exposing account metadata.

Preparation is limited to two authenticated requests in any rolling ten-minute
window, including duplicate or rejected requests. A deployment also keeps an
independent conservative IP limit. Data-manager permits at most one running and
two queued requests per opaque account principal, and retains at most five
artifact references totaling 5 GiB of logical bytes. Shared physical archives
are charged at their full size to each retaining principal. A `429` response
includes a bounded `Retry-After` value; wait that many seconds before retrying.
Signing out closes and aborts a pending preparation UI, while a later sign-in
may resume only jobs owned by that same derived principal.

Packages do **not** contain another style bundle, sprite bundle, or copied layer
definitions. Online and offline rendering both load the web app's configured
OpenMapX style and sprites. Going offline rewrites only:

- the `openmaptiles` vector source to a local `pmtiles://` URL; and
- the glyph template to the package's immutable glyph cache.

This means colors, expressions, layer order, icons, language handling, theme
switches, and environment-selected OpenMapX presentation stay identical. A
deployment using MapTiler's complete hosted style cannot prepare OpenMapX
offline packages; select the `openmapx` provider first.

The schema-2 manifest records coverage, zooms, tile schema, source and glyph
versions, attribution, byte length, SHA-256, and immutable ETag. Package IDs are
content-addressed from the canonical request and every input embedded in the
archive, including attribution.

## Download and storage guarantees

Archive downloads support byte ranges and resume only when the server accepts
the exact verified prefix and immutable ETag. Before a package becomes ready,
the browser verifies:

- declared byte length and SHA-256;
- the PMTiles v3 header, compression, MVT type, section ranges, bounds, zooms,
  directory structure, and metadata; and
- the configured style, sprite, and required glyph assets.

Metadata lives in IndexedDB. Archives use the Origin Private File System when
available; the IndexedDB Blob fallback reads finalized archives in bounded
slices instead of loading the entire PMTiles file into memory. Missing ready
archives are reconciled into a resumable error state rather than advertised to
the map.

The service worker installs a credential-free offline entry page, both bundled
styles, and required sprites as one app-shell generation. Navigation responses,
including the home page, are never stored: documents are network-only and an
offline failure may resolve only to that distinct `/offline` cache key. This
prevents account, role, locale, reset-token, and callback state from crossing a
browser-session boundary through Cache Storage.

PMTiles bytes never enter Cache Storage: the page-side protocol reads them
directly. Glyphs use a separate cache keyed by their content version and are
removed only after the last package using that version is deleted. Glyph cache
keys use the manifest's stable API path; `NEXT_PUBLIC_API_URL` only selects where
missing glyphs are downloaded from, so moving the API origin does not strand
installed assets. Cache Storage is a readiness requirement—a package is not
advertised as ready if its glyphs cannot be retained durably.

## Rendering one or many areas

All compatible ready areas are exposed as one MapLibre vector source and reuse
the configured layer list once. The local protocol tries the ordered package
set for each requested tile. This avoids duplicated fills and labels in
overlaps and lets adjacent packages appear without swapping the whole style at
each boundary. More specific coverage wins point selection; equally sized
overlaps prefer the newer generated package.

A local archive is compatible when it uses the OpenMapTiles tile schema the
bundled OpenMapX style expects. Dataset refreshes do not make already verified
tiles structurally unreadable. Corrupt or missing archives are excluded and can
be downloaded again from Settings.

## Offline navigation

OpenMapX can continue a ground route that was planned online. It stores one
bounded, schema-versioned snapshot containing route geometry, maneuvers,
alternatives, waypoints, options, progress, and intersecting offline package
IDs. Route-to-package matching checks complete line segments, including a
segment that crosses a package even when neither endpoint lies inside it.

After reload, restoring the route always requires confirmation. Coverage is
recomputed from currently ready packages, so an area downloaded after the last
route checkpoint is recognized and a deleted area is not reported as present.
While offline:

- existing geometry, maneuvers, progress, voice guidance, and the last known
  route remain available;
- reroute, faster-route, incident, traffic-signal, and alert requests are
  suppressed; and
- the UI distinguishes a covered map from route-line-only continuation.

Reconnection does not silently replace the route. The user can deliberately
retry rerouting when connectivity returns. Snapshots expire after 24 hours and
exclude raw GPS history, live responses, and transient route proposals.

Planning a new route, arbitrary rerouting, live traffic, live transit, search,
and network-backed overlays are not offline capabilities.

## Source and attribution boundary

Offline preparation uses only the deployment's self-hosted OpenMapX MBTiles and
glyph inputs. It never fetches a style from a repository or packages a
MapTiler-hosted dataset. Visible package credits are therefore OpenStreetMap and
OpenMapTiles. The online fallback additionally shows MapTiler attribution when
`NEXT_PUBLIC_TILES_URL` is not configured.

See [Self-hosting map tiles](../guides/map-tiles.md) for the two source inputs
and deployment variables.
