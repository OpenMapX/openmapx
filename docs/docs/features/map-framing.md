---
title: Map framing and street alignment
description: How the map keeps places and routes out from under panels, and how to rotate the map to the local street grid.
---

# Map framing and street alignment

When you pick a place, a route, a transit line, or a shared link, the map frames
it in the part of the screen you can actually see. Under the hood, OpenMapX
uses a **Map Obstruction Registry** where active UI elements — the desktop side
panel and detail card, the mobile bottom sheet, the search bar and category row
on phones, the navigation banner, and safe-area insets — publish their pixel
extents.

A **Camera Padding Resolver** transforms these obstructions into map camera padding,
with strict safety clamping to ensure at least 30% of each viewport axis and at least
160px of map space remains visible (`MIN_VISIBLE_FRACTION = 0.3`, `MIN_VISIBLE_PX = 160px`).
Opening or collapsing a panel dynamically slides the map camera; the slide is instant
when your system prefers reduced motion.

Framing preserves your viewing angle. If you have rotated the map — by dragging
or using the street grid alignment tool — opening a new place or route maintains
that bearing until you explicitly return to north.

During turn-by-turn ground navigation, the vehicle position marker is offset to
sit three-quarters of the way down the visible viewport (`PUCK_SCREEN_RATIO = 0.75`),
giving maximum visibility to the road ahead. "Overview" mode is the one deliberate
exception: it frames the full extent of the route and resets the map to a flat,
north-up orientation.

## Align to streets

The grid button in the map controls rotates the map bearing so surrounding streets
align vertically with your display. It runs entirely client-side, inspecting vector
tile features already loaded in the browser with zero network requests.

The alignment engine follows strict geometric heuristics:

- **Zoom threshold**: The control only appears at or above zoom 13 (`ALIGN_MIN_ZOOM = 13`).
  At lower zooms, road grids are too dense and the button is hidden.
- **Sample window**: It analyzes vector line geometry from the vector style's
  `transportation` source layer across the center 70% of the visible viewport.
- **Road class weighting**: Local and tertiary streets receive full weight (`1.0`),
  secondary streets `0.9`, primary roads `0.8`, trunks `0.4`, and motorways `0.3`,
  ensuring local neighborhood grids take precedence over diagonal highways.
- **Confidence threshold**: Alignment requires at least 800 weighted road pixels
  and a dominant angle confidence of at least 60% (`ALIGN_MIN_CONFIDENCE = 0.6`).
- **Dead-band**: If the current bearing is already within 2° of the detected street
  angle, the button reports that the map is already aligned.

The compass control returns the map to north-up at any time, and both actions are
accessible from the command palette.
