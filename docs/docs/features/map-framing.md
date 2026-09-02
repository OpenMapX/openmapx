---
title: Map framing and street alignment
description: How the map keeps places and routes out from under panels, and how to rotate the map to the local street grid.
---

# Map framing and street alignment

When you pick a place, a route, a transit line, or a shared link, the map frames
it in the part of the screen you can actually see. The desktop side panel and
detail card, the mobile bottom sheet, the search bar and category row on
phones, the navigation banner and its bottom panel, and your device's safe
areas are all treated as covering the map, so the content lands beside or above
them rather than underneath. Opening or collapsing a panel slides the map by the
same amount; the slide is instant when your system asks for reduced motion.

During turn-by-turn navigation the position marker keeps sitting three quarters
of the way down the visible strip between the instruction banner and the bottom
panel, and dragging the panel up moves the map with it. "Overview" frames the
whole route in the visible area.

## Align to streets

The grid button in the map controls rotates the map so the surrounding streets
run up and down the screen. It looks only at roads already drawn on screen, so
it works offline and never sends a request. The button appears once you are
zoomed in close enough for streets to be worth aligning to — from further out it
is simply not offered. When you press it and the roads near the middle of the
view form no clear grid, or the map already lines up with them, a short message
says so instead. The compass returns the map to north-up at any time, and both
actions are also available in the command palette.
