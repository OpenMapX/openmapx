---
title: Schematic transit map
description: View rail networks as geographic, octilinear, or radial plans.
---

# Schematic transit map

Enable **Schematic transit map** in Layers, then choose a layout in the legend:
geographic, octilinear, or radial. Choose the network group for trams,
metro/light rail, commuter rail, or long-distance rail. The group controls select
one network at a time.

The schematic layer and ordinary **Transit lines** exclude one another. Turning
one on switches the other off. Bus and ferry networks are not included.

LOOM at the University of Freiburg renders the tiles from OpenStreetMap data;
OpenMapX proxies them through its server. Coverage and update frequency depend
on OSM mapping and LOOM publication. A network plan does not supply current
service, departures, or disruption information. Use
[Public transit](./public-transit.md) for those features.

The integration is enabled by default and needs no credentials. Operators can
disable it or set `tileBaseUrl` to a compatible self-hosted LOOM endpoint under
**Admin → Integrations**.
