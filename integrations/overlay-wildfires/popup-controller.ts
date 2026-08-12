import type * as maplibregl from "maplibre-gl";

export type WildfirePopupLease = object;

export interface WildfirePopupController {
  open(lease: WildfirePopupLease, popup: maplibregl.Popup): void;
  close(lease: WildfirePopupLease): void;
  closeAll(): void;
}

export function createWildfirePopupController(): WildfirePopupController {
  let current: { lease: WildfirePopupLease; popup: maplibregl.Popup } | null = null;

  const closeAll = () => {
    const ownedPopup = current;
    current = null;
    ownedPopup?.popup.remove();
  };

  return {
    open: (lease, popup) => {
      closeAll();
      current = { lease, popup };
    },
    close: (lease) => {
      if (current?.lease !== lease) return;
      closeAll();
    },
    closeAll,
  };
}
