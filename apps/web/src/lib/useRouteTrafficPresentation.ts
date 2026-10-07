"use client";

import type { Route } from "@openmapx/core";
import { useEffect, useState } from "react";
import { routeTrafficPresentation } from "./route-traffic-delay";

/** Re-evaluate a held route when its congestion evidence expires. */
export function useRouteTrafficPresentation(route: Route) {
  const [, refresh] = useState(0);
  const presentation = routeTrafficPresentation(route, Date.now());
  const deadline = presentation.deadline;
  useEffect(() => {
    if (deadline === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expire = () => {
      const remaining = deadline - Date.now();
      // A backwards clock correction must not expire the lease early.
      if (remaining > 0) timer = setTimeout(expire, remaining);
      else refresh((revision) => revision + 1);
    };
    expire();
    return () => clearTimeout(timer);
  }, [deadline]);
  return presentation;
}
