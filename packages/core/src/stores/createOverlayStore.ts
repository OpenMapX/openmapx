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

interface OverlayStoreConfig<
  TExtra extends Record<string, unknown>,
  TActions extends Record<string, (...args: never[]) => void>,
> {
  extra: TExtra;
  actions?: (
    set: (partial: Partial<OverlayStoreBase & TExtra>) => void,
    get: GetState<OverlayStoreBase & TExtra & TActions>,
  ) => TActions;
  onClose?: () => Partial<TExtra>;
}

export function createOverlayStore<
  TExtra extends Record<string, unknown>,
  TActions extends Record<string, (...args: never[]) => void> = Record<string, never>,
>(
  config: OverlayStoreConfig<TExtra, TActions>,
): UseBoundStore<StoreApi<OverlayStoreBase & TExtra & TActions>> {
  type FullState = OverlayStoreBase & TExtra & TActions;

  return create<FullState>((set, get) => {
    const extraActions = config.actions
      ? config.actions((partial) => set(partial as Partial<FullState>), get as GetState<FullState>)
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
}
