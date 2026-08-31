---
title: Schematic Transit Map
description: Metro-map style transit network overlay rendered from OpenStreetMap by LOOM.
---

# Schematic Transit Map

The schematic transit map overlay draws tram, metro and light rail, commuter rail, and long-distance rail networks the way printed network plans do. Choose between the geographic layout, the classic metro-map (octilinear) layout, and a radial layout from the legend, and switch between the four network groups.

Tiles are rendered from OpenStreetMap data by [LOOM](https://loom.cs.uni-freiburg.de/tiles) (University of Freiburg) and proxied through the OpenMapX server — the browser never contacts the upstream service. Coverage and freshness follow OpenStreetMap's transit mapping and LOOM's rebuild cadence, so both vary by region. Bus and ferry networks are not part of the upstream data.

The overlay is enabled by default and needs no credentials. Operators can disable it, or point `tileBaseUrl` at a self-hosted LOOM instance, under **Admin → Integrations → Schematic Transit Map**.
