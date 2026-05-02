import type { StoreApi, UseBoundStore } from "zustand";
import { create } from "zustand";

export interface OverlayStoreBase {
  panelOpen: boolean;
  layerVisible: boolean;
  openPanel: () => void;
  closePanel: () => void;
  setLayerVisible: (visible: boolean) => void;
}

type GetState<T> = StoreApi<T>["getState"];
type SetPartial<T> = (partial: Partial<T> | ((state: T) => Partial<T>)) => void;

interface OverlayStoreConfig<
  TExtra extends Record<string, unknown>,
  TActions extends Record<string, (...args: never[]) => void>,
> {
  /** Overlay ID used for dynamic registration. When set, the store is automatically
   *  added to the overlay store registry so overlayRegistry.ts can look it up at runtime. */
  overlayId?: string;
  extra: TExtra;
  actions?: (
    set: SetPartial<OverlayStoreBase & TExtra>,
    get: GetState<OverlayStoreBase & TExtra & TActions>,
  ) => TActions;
  onClose?: () => Partial<TExtra>;
}

/**
 * Runtime registry of overlay stores keyed by overlay ID.
 * Populated automatically by createOverlayStore when overlayId is provided.
 */
const overlayStoreMap = new Map<string, UseBoundStore<StoreApi<OverlayStoreBase>>>();

/** Get a store by its overlay ID. Used by overlayRegistry.ts. */
export function getRegisteredOverlayStore(
  overlayId: string,
): UseBoundStore<StoreApi<OverlayStoreBase>> | undefined {
  return overlayStoreMap.get(overlayId);
}

/** Get all registered overlay store IDs. */
export function getRegisteredOverlayIds(): string[] {
  return Array.from(overlayStoreMap.keys());
}

export function createOverlayStore<
  TExtra extends Record<string, unknown>,
  TActions extends Record<string, (...args: never[]) => void> = Record<string, never>,
>(
  config: OverlayStoreConfig<TExtra, TActions>,
): UseBoundStore<StoreApi<OverlayStoreBase & TExtra & TActions>> {
  type FullState = OverlayStoreBase & TExtra & TActions;

  const store = create<FullState>((set, get) => {
    const extraActions = config.actions
      ? config.actions(
          (partial) =>
            set(partial as Partial<FullState> | ((state: FullState) => Partial<FullState>)),
          get as GetState<FullState>,
        )
      : ({} as TActions);

    return {
      panelOpen: false,
      layerVisible: false,
      openPanel: () => set({ panelOpen: true, layerVisible: true } as Partial<FullState>),
      closePanel: () =>
        set({
          panelOpen: false,
          layerVisible: false,
          ...(config.onClose ? config.onClose() : {}),
        } as Partial<FullState>),
      setLayerVisible: (layerVisible: boolean) => set({ layerVisible } as Partial<FullState>),
      ...config.extra,
      ...extraActions,
    } as FullState;
  });

  if (config.overlayId) {
    overlayStoreMap.set(
      config.overlayId,
      store as unknown as UseBoundStore<StoreApi<OverlayStoreBase>>,
    );
  }

  return store;
}
