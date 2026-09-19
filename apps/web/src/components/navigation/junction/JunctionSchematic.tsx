"use client";

import Box from "@mui/material/Box";
import type { JunctionSchematic } from "@openmapx/core";

/**
 * The SVG drawing of a junction schematic: lane bands under perspective, the
 * active lane emphasised, the ramp peeling off. `aria-hidden` — the wrapping
 * panel is the accessible surface.
 */
export function JunctionSchematicView({ schematic }: { schematic: JunctionSchematic }) {
  return (
    <Box
      component="svg"
      viewBox={`0 0 ${schematic.width} ${schematic.height}`}
      sx={{ width: "100%", height: 140, display: "block" }}
      aria-hidden
      data-testid="junction-schematic"
    >
      <path data-through d={schematic.throughPath} fill="#3a3d42" />
      {schematic.lanePolygons.map((d, i) => (
        <path
          // biome-ignore lint/suspicious/noArrayIndexKey: lane bands have no stable id
          key={i}
          data-lane
          data-active={String(schematic.activeLanes.includes(i))}
          d={d}
          fill={schematic.activeLanes.includes(i) ? "#9fd0ff" : "#565b63"}
          // A faint seam between plain lanes makes them countable; the active
          // lane gets a bold outline on top of its fill, so it is never colour alone.
          stroke={schematic.activeLanes.includes(i) ? "#ffffff" : "#2b2e33"}
          strokeWidth={schematic.activeLanes.includes(i) ? 1.5 : 1}
        />
      ))}
      <path data-ramp d={schematic.rampPath} fill="#9fd0ff" />
    </Box>
  );
}
