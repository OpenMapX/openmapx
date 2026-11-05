---
title: Overture Places
description: Additional locally hosted places, source identity, and map publication limits.
sidebar_position: 3
---

# Overture Places

An instance can add a local Overture Places snapshot alongside OpenStreetMap.
It can supply additional category-search results and fill gaps in place details.
An Overture-only result has its own place card and GERS identifier; a matched
OpenStreetMap result keeps its OSM identity.

The feature is optional and disabled by default for search and enrichment.
Without it, the standard POI search can continue through OpenStreetMap and
Overpass. Check each result's source credits to see what supplied it.

## Imported fields

Available fields include names, coordinates, categories, addresses, contacts,
brands, confidence, operating status, release, and source records. Opening hours
are not supplied by the Overture Places import. An operating status of `open`
does not establish that a business is open at the current time.

Category matching uses the imported taxonomy and supported broad OpenMapX
categories. Unsupported categories or missing attributes can leave places out
of filtered searches.

## Identity, fusion, and quality

OpenMapX uses accepted OSM/GERS links and conservative matching to combine
records for the same place. OSM takes precedence for overlapping fields;
Overture can fill missing fields. Unmatched Overture records remain separate.
Matching can still miss duplicates or inherit incorrect source data.

Search results are bounded and ranked. They do not list every place in the
installed dataset. A stable identifier helps recognize a record; it does not
verify its address, category, or current operating status.

## Nearby places during normal browsing

An operator can separately publish a nearby-place snapshot for ordinary map
browsing. It can use named OSM places with optional Overture augmentation.
Enabling Overture search does not itself publish these map labels.

Published destinations appear automatically, without a Layers switch. Essential
destinations can appear from zoom 13, everyday businesses from 15, other places
from 16, and mapped non-ground tenants from 18. Ranking and label collisions
limit what appears. Select a label to open its place details.

The publisher excludes specified closed, disused, demolished, or private OSM
records. Overture candidates need known `open` status and confidence of at least
0.5. These rules reduce unsuitable labels; they do not certify that every shown
business is current. Coverage depends on the prepared source region and filters.

Discovery stops showing a disabled publication or one whose publication or input
snapshots are older than 90 days.
A fresh last-known publication can survive a temporary discovery failure on the
same page and API origin. Cached tiles have a separate seven-day lease, so
operator disablement does not immediately revoke copies already downloaded.

## Releases and regional refreshes

Operators enable the data lifecycle with `OVERTURE_ENABLED=true`, prepare the
chosen source region, and enable `poi-overture` and/or `knowledge-overture` under
**Admin → Integrations**. The two runtime integrations are independent.

A refresh stages and checks an immutable release before replacing the active
Places snapshot. Link rebuilding is a separate resumable workflow; an incomplete
rebuild does not establish readiness for nearby-place publication. Failed work
preserves the prior published data at the relevant boundary.

The admin panel offers these operations under **Services → Data workflows →
Overture Places**. **Full sync** runs the complete refresh. **Resume links**
continues the installed release's durable rebuild; **Restart links from scratch**
discards its resumable workspace while preserving published Places. Both show a
server preview before confirmation. **Advanced recovery** exposes download,
ingest and OSM extraction separately. Ingest uses the newest completed local
partition for the selected region; it does not discover a newer upstream release.
The worker rechecks installed Places, the region's OSM PBF and conflicting work
under the shared Overture lease before execution. Follow the retained job in
Activity; acceptance does not establish publication readiness.

Use [Preparing data](../install/preparing-data.md) for source preparation and the
[publication reference](../developer/ambient-places-publication.md) for generation
activation, status, capacity, restart, rollback, and cache behavior. Review
representative local samples before publishing a larger region. Existing
quality fixtures do not establish matching quality everywhere.

## Provenance, licensing, and privacy

Records retain source dataset, property, record, license, update, and release
information where supplied. The UI credits sources that contributed returned
records. Overture Places has multiple contributor licenses; importing a local
copy does not remove their attribution obligations. Follow the recorded source
terms and [Overture's attribution reference](https://docs.overturemaps.org/attribution/).

Overture search and details use local PostGIS data. Those requests do not send
the user's viewport to Overture or its contributors. Other enabled geocoders,
photos, knowledge providers, or external links can still contact their own
sources. Check the instance's privacy information.

## Global source preparation

Planet preparation and publication require matching planet sources, substantial
RAM and scratch space, bounded extraction and matching work, and completed link
publication. Selecting **Planet** in the nearby-place form does not download or
prepare those inputs. Follow the
[global deployment runbook](../developer/ambient-places-publication.md#planet-preparation-restart-and-deployment)
before attempting it. Regional source data cannot establish global coverage.
