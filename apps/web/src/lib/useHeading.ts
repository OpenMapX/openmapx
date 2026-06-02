"use client";

import { useEffect, useState } from "react";
import { hasCapability } from "./platformCapabilities";

interface CompassEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

/**
 * Track compass heading (degrees, 0 = north) from device orientation while
 * `active`. Uses iOS `webkitCompassHeading` when present, else `alpha`.
 * Returns null when unavailable. iOS permission must be granted by the caller.
 */
export function useHeading(active: boolean): number | null {
  const [heading, setHeading] = useState<number | null>(null);

  useEffect(() => {
    if (!active || !hasCapability("deviceOrientation")) return;
    const onOrient = (raw: Event) => {
      const e = raw as CompassEvent;
      if (typeof e.webkitCompassHeading === "number") {
        setHeading(e.webkitCompassHeading);
      } else if (typeof e.alpha === "number") {
        setHeading((360 - e.alpha) % 360);
      }
    };
    window.addEventListener("deviceorientationabsolute", onOrient as EventListener);
    window.addEventListener("deviceorientation", onOrient as EventListener);
    return () => {
      window.removeEventListener("deviceorientationabsolute", onOrient as EventListener);
      window.removeEventListener("deviceorientation", onOrient as EventListener);
    };
  }, [active]);

  return active ? heading : null;
}

/** Request iOS device-orientation permission from a user gesture. Resolves true if granted/none-needed. */
export async function requestHeadingPermission(): Promise<boolean> {
  const Ctor = (typeof window !== "undefined" ? window.DeviceOrientationEvent : undefined) as
    | (typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> })
    | undefined;
  if (Ctor && typeof Ctor.requestPermission === "function") {
    try {
      return (await Ctor.requestPermission()) === "granted";
    } catch {
      return false;
    }
  }
  return true;
}
