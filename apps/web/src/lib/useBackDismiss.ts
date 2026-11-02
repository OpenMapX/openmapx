"use client";

import { useEffect, useRef } from "react";
import { openBackLayer } from "./backNavigation";

/**
 * Lets the system Back gesture dismiss a transient surface while it is open.
 *
 * `onBack` should close the surface exactly like its own close control. When
 * the surface closes any other way, its entry stays behind and a later Back
 * steps over it (see backNavigation). An owner that ignores `onBack` and stays
 * open simply loses the entry: the next Back then goes past it rather than
 * being trapped.
 */
export function useBackDismiss(active: boolean, onBack: () => void): void {
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });

  useEffect(() => {
    if (!active) return;
    const layer = openBackLayer(() => onBackRef.current());
    return () => layer.release();
  }, [active]);
}
