"use client";

/** Raw physical geometry belongs to the same owner as its outlet and follow cap. */
export interface MobileFooterSurface {
  host: HTMLElement;
  outlet: HTMLElement;
  /** Global stacking layer, including any ancestor (navigation is inside 1300). */
  stackLevel: number;
  visibleHeight: number;
  bottom: number;
  followCap: number;
}

const surfaces = new Map<string, MobileFooterSurface>();
const listeners = new Set<() => void>();

export function publishMobileFooterSurface(id: string, surface: MobileFooterSurface | null) {
  if (surface) surfaces.set(id, surface);
  else if (!surfaces.delete(id)) return;
  for (const listener of listeners) listener();
}

export function subscribeMobileFooterSurfaces(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** DOM order breaks ties, never effect registration order. */
export function topMobileFooterSurface(): MobileFooterSurface | null {
  let top: MobileFooterSurface | null = null;
  for (const surface of surfaces.values()) {
    if (!surface.host.isConnected || !surface.outlet.isConnected || surface.visibleHeight <= 0)
      continue;
    if (
      !top ||
      surface.stackLevel > top.stackLevel ||
      (surface.stackLevel === top.stackLevel &&
        top.host.compareDocumentPosition(surface.host) & Node.DOCUMENT_POSITION_FOLLOWING)
    )
      top = surface;
  }
  return top;
}
