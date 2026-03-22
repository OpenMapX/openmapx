"use client";

import type { ElevationPoint } from "@openmapx/core";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

interface ElevationHoverState {
  hoveredIndex: number | null;
  hoveredPoint: ElevationPoint | null;
  setHoveredIndex: (index: number | null) => void;
  points: ElevationPoint[];
  setPoints: (points: ElevationPoint[]) => void;
}

const ElevationHoverContext = createContext<ElevationHoverState>({
  hoveredIndex: null,
  hoveredPoint: null,
  setHoveredIndex: () => {},
  points: [],
  setPoints: () => {},
});

export function ElevationHoverProvider({ children }: { children: ReactNode }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [points, setPoints] = useState<ElevationPoint[]>([]);

  const hoveredPoint = hoveredIndex !== null ? (points[hoveredIndex] ?? null) : null;

  const value = useMemo(
    () => ({ hoveredIndex, hoveredPoint, setHoveredIndex, points, setPoints }),
    [hoveredIndex, hoveredPoint, points],
  );

  return <ElevationHoverContext.Provider value={value}>{children}</ElevationHoverContext.Provider>;
}

export function useElevationHover() {
  return useContext(ElevationHoverContext);
}
