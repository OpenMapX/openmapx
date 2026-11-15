"use client";

import Box from "@mui/material/Box";
import type { ReactNode } from "react";

/**
 * A vertical timeline drawn like a line map: a rail column with markers,
 * what happens in the middle, and when on the right. Shared by the transit
 * trip timeline and the personal timeline.
 */

/** Width of the rail column, and of the line drawn in it. */
const RAIL_WIDTH = 48;
const LINE_WIDTH = 8;
/** Where a point's marker sits: level with its name's first line. */
const NODE_Y = 20;

export interface RailSegment {
  color: string;
  dotted: boolean;
}

function RailLine({
  segment,
  top,
  bottom,
  height,
}: {
  segment?: RailSegment;
  top: number;
  bottom?: number;
  height?: number;
}) {
  if (!segment) return null;
  return (
    <Box
      sx={{
        position: "absolute",
        left: "50%",
        transform: "translateX(-50%)",
        width: LINE_WIDTH,
        top,
        bottom,
        height,
        ...(segment.dotted
          ? {
              backgroundImage: `radial-gradient(circle, ${segment.color} 2.5px, transparent 3px)`,
              backgroundSize: `${LINE_WIDTH}px 10px`,
              backgroundRepeat: "repeat-y",
              backgroundPosition: "center top",
            }
          : { bgcolor: segment.color }),
      }}
    />
  );
}

/**
 * One row of the timeline: the rail with an optional marker, what happens
 * there, and when. A point row joins the leg that arrives (`above`) to the one
 * that leaves (`below`); a leg row carries one segment `through`.
 */
export function TimelineRow({
  above,
  below,
  through,
  node,
  nodeY = NODE_Y,
  time,
  divider = false,
  dense = false,
  children,
}: {
  above?: RailSegment;
  below?: RailSegment;
  through?: RailSegment;
  node?: ReactNode;
  nodeY?: number;
  time?: ReactNode;
  divider?: boolean;
  /** A tighter row, for the stops a ride passes. */
  dense?: boolean;
  children?: ReactNode;
}) {
  const cell = {
    py: dense ? 0.5 : 1,
    borderTop: divider ? 1 : 0,
    borderColor: "divider",
  } as const;
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: `${RAIL_WIDTH}px minmax(0, 1fr) auto` }}>
      <Box aria-hidden sx={{ position: "relative" }}>
        {through ? (
          <RailLine segment={through} top={0} bottom={0} />
        ) : (
          <>
            <RailLine segment={above} top={0} height={nodeY} />
            <RailLine segment={below} top={nodeY} bottom={0} />
          </>
        )}
        {node && (
          <Box
            sx={{
              position: "absolute",
              left: "50%",
              top: nodeY,
              transform: "translate(-50%, -50%)",
              display: "flex",
            }}
          >
            {node}
          </Box>
        )}
      </Box>
      <Box sx={{ ...cell, pl: 0.5, minWidth: 0 }}>{children}</Box>
      <Box sx={{ ...cell, pl: 1, textAlign: "right", whiteSpace: "nowrap" }}>{time}</Box>
    </Box>
  );
}

/** A stop on the rail: a ring in the line's colour, filled to stand out. */
export function RailDot({
  color,
  size = 16,
  filled = false,
}: {
  color: string;
  size?: number;
  filled?: boolean;
}) {
  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: `${Math.max(2, Math.round(size / 5))}px solid`,
        borderColor: color,
        bgcolor: filled ? color : "background.paper",
      }}
    />
  );
}
