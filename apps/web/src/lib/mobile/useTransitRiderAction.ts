"use client";
import { useNavigationStore } from "@openmapx/core";
import { type TransitRiderAction, transitItineraryFingerprint } from "@openmapx/core/navigation";
import { useMobileRuntimeContext } from "./MobileRuntimeProvider";
/** Rider actions acknowledge native state before changing the web read model. */
export function useTransitRiderAction() {
  const runtime = useMobileRuntimeContext();
  return async (action: TransitRiderAction) => {
    const store = useNavigationStore.getState();
    if (runtime.browserAuthority) {
      if (!store.applyTransitAction(action)) throw Error("invalid-action");
      return;
    }
    if (!runtime.commands || !runtime.handshake?.capabilities.transitActions || !store.itinerary)
      throw Error("unavailable");
    try {
      await runtime.commands.transitAction({
        ...action,
        actionId: crypto.randomUUID(),
        itineraryFingerprint:
          store.nativeRouteFingerprint ?? transitItineraryFingerprint(store.itinerary),
        expectedPhase: store.transitProgress?.phase ?? "walking",
      });
    } catch (error) {
      void runtime.commands.requestSnapshot();
      throw error;
    }
  };
}
