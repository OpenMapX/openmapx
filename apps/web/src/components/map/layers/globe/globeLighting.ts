import {
  isOverlayActive,
  runOverlayTransaction,
  useIntegrationOverlayActive,
  useLayerStore,
} from "@openmapx/core";

/**
 * The "Daylight & time zones" overlay draws its own terminator, with a time of
 * its own choosing. It and the globe's day and night never show together:
 * opening the overlay suspends the globe's lighting without changing the
 * stored preference, and choosing day and night closes the overlay, as
 * opening an overlay closes the overlays it excludes.
 */
const SUN_TIME_OVERLAY_ID = "sun-time";

/** Whether the globe draws real-time day and night right now. */
export function useGlobeLightingActive(): boolean {
  const preferred = useLayerStore((s) => s.globeLighting);
  const suspended = useIntegrationOverlayActive(SUN_TIME_OVERLAY_ID);
  return preferred && !suspended;
}

/** The Day and night control: off when it shows, otherwise on, closing the overlay. */
export function toggleGlobeLighting(): void {
  const store = useLayerStore.getState();
  const suspended = isOverlayActive(SUN_TIME_OVERLAY_ID);
  if (store.globeLighting && !suspended) {
    store.setGlobeLighting(false);
    return;
  }
  store.setGlobeLighting(true);
  if (suspended) {
    runOverlayTransaction(SUN_TIME_OVERLAY_ID, { panelOpen: false }, { kind: "user" });
  }
}
