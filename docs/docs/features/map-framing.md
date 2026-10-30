---
title: Map framing and street alignment
description: Keep places and routes visible around panels, and rotate the map to the local street grid.
---

# Map framing and street alignment

When you select a place, route, transit line, or shared link, OpenMapX adjusts the
map to keep it visible around open panels. Opening or collapsing a panel adjusts
the visible area. These camera adjustments are immediate when your system
requests reduced motion.

Your viewing angle is preserved when you open another place or route. Use the
compass to return to north. During ground navigation, your position appears
below the center of the visible map so you can see more of the road ahead.
**Overview** frames the whole route and returns to a flat, north-up view.

## Reopening the map

OpenMapX reopens the map where you last left it, at the same position and zoom.
A shared link or a reload opens on the view in its address instead. When the
last view is restored, your current location only places the location marker
and does not move the map. The last view is saved in this browser only. Turn off
**Remember map view** in Settings to open on your location (when location access
is already granted) or the world view instead; turning it off deletes the saved
view.

## Align to streets

Zoom in to at least level 13, then use the grid button in the map controls to
rotate nearby streets vertically on the screen. The control is unavailable
during navigation. It reads road geometry already loaded in the browser and
does not send an additional provider request.

Alignment needs enough visible roads with a consistent direction. If it cannot
find a clear street grid, try another map position or zoom. When the map is
already close to the detected angle, the control reports that it is aligned.

The compass returns to north-up. Both alignment and north-up are also available
from the command palette.

For camera and street-grid implementation details, see `cameraPadding.ts`,
`streetGrid.ts`, and `useAlignToStreets.ts` in
[the web app's map utilities](https://github.com/OpenMapX/openmapx/tree/main/apps/web/src/lib).
