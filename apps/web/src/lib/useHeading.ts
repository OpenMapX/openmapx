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
    // Once the absolute event fires we ignore the relative `deviceorientation`
    // fallback, so devices that support both don't double-fire setHeading.
    let absoluteSeen = false;
    const apply = (e: CompassEvent) => {
      if (typeof e.webkitCompassHeading === "number") {
        setHeading(e.webkitCompassHeading);
      } else if (typeof e.alpha === "number") {
        setHeading((360 - e.alpha) % 360);
      }
    };
    const onAbsolute = (raw: Event) => {
      absoluteSeen = true;
      apply(raw as CompassEvent);
    };
    const onRelative = (raw: Event) => {
      if (absoluteSeen) return;
      apply(raw as CompassEvent);
    };
    window.addEventListener("deviceorientationabsolute", onAbsolute as EventListener);
    window.addEventListener("deviceorientation", onRelative as EventListener);
    return () => {
      window.removeEventListener("deviceorientationabsolute", onAbsolute as EventListener);
      window.removeEventListener("deviceorientation", onRelative as EventListener);
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
