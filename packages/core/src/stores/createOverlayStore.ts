import type { StoreApi, UseBoundStore } from "zustand";
import { create } from "zustand";

export interface OverlayStoreBase {
  panelOpen: boolean;
  layerVisible: boolean;
  /** Bumped by every direct call to openPanel/closePanel/setLayerVisible — but
   *  NOT by a write applied through runOverlayTransaction (overlayRegistry.ts).
   *  A direct call always originates outside contextual automation (a legend
   *  checkbox, the deep-link applier, another integration), so this is the
   *  answer to "has something other than automation touched this overlay
   *  since revision N" that contextual restore logic depends on. */
  userRevision: number;
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

const overlayChangeListeners = new Set<() => void>();

/**
 * Wake every subscribeOverlayStoreChanges listener. Fired for store state
 * changes and registrations here, and by overlayRegistry.ts whenever the
 * registry itself is (re)populated, so readiness hooks re-read on the same
 * signal that store hooks already use.
 */
export function notifyOverlayChangeListeners(): void {
  for (const listener of overlayChangeListeners) listener();
}

/**
 * True while a transaction (runOverlayTransaction, overlayRegistry.ts) is
 * applying its own writes, so the base actions below know to skip the
 * userRevision bump — a transaction's writes are automation re-stating a
 * decision it already made, not a new user/external change. This MUST only
 * ever be true for the duration of a synchronous call: if a transaction ever
 * awaited something between opening and closing this window, an unrelated
 * direct call from anywhere else in the app could land inside that window
 * and silently lose its bump. runOverlayTransaction enforces this by never
 * awaiting inside runInOverlayTransaction.
 */
let inOverlayTransaction = false;

/**
 * Runs `apply` with the shared transaction flag set, so every base-store
 * write it triggers (however many stores it touches) skips the userRevision
 * bump. `apply` must be fully synchronous — see the flag's own doc comment.
 */
export function runInOverlayTransaction<T>(apply: () => T): T {
  const previous = inOverlayTransaction;
  inOverlayTransaction = true;
  try {
    return apply();
  } finally {
    inOverlayTransaction = previous;
  }
}

/**
 * Subscribe to state changes across ALL overlay stores. Unlike subscribing to a
 * store instance directly, this signal survives an instance being replaced in
 * the registry (a lazy-loaded map-layer's module-scope createOverlayStore call
 * overwrites any store auto-created for the same overlayId earlier) — every
 * store, including later replacements, forwards its changes here. Pair with
 * getRegisteredOverlayStore lookups at read time for always-current state.
 */
export function subscribeOverlayStoreChanges(listener: () => void): () => void {
  overlayChangeListeners.add(listener);
  return () => {
    overlayChangeListeners.delete(listener);
  };
}

/**
 * Overlay ids whose current store is a stand-in created by the registry
 * because the overlay's own module (and its createOverlayStore call) had not
 * loaded yet. The real store inherits the stand-in's open state when it
 * arrives, so a deep link or user toggle applied in the meantime survives.
 */
const placeholderOverlayIds = new Set<string>();

/**
 * Create the stand-in store the registry uses for an overlay whose module is
 * still loading. Only the registry should call this; integration modules call
 * createOverlayStore, which recognises and adopts the stand-in's state.
 */
export function createPlaceholderOverlayStore(
  overlayId: string,
): UseBoundStore<StoreApi<OverlayStoreBase>> {
  const store = createOverlayStore({ overlayId, extra: {} });
  placeholderOverlayIds.add(overlayId);
  return store as unknown as UseBoundStore<StoreApi<OverlayStoreBase>>;
}

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
      userRevision: 0,
      openPanel: () =>
        set(
          (state) =>
            ({
              panelOpen: true,
              layerVisible: true,
              userRevision: inOverlayTransaction ? state.userRevision : state.userRevision + 1,
            }) as Partial<FullState>,
        ),
      closePanel: () =>
        set(
          (state) =>
            ({
              panelOpen: false,
              layerVisible: false,
              userRevision: inOverlayTransaction ? state.userRevision : state.userRevision + 1,
              ...(config.onClose ? config.onClose() : {}),
            }) as Partial<FullState>,
        ),
      setLayerVisible: (layerVisible: boolean) =>
        set(
          (state) =>
            ({
              layerVisible,
              userRevision: inOverlayTransaction ? state.userRevision : state.userRevision + 1,
            }) as Partial<FullState>,
        ),
      ...config.extra,
      ...extraActions,
    } as FullState;
  });

  store.subscribe(notifyOverlayChangeListeners);

  if (config.overlayId) {
    const previous = overlayStoreMap.get(config.overlayId);
    const adoptsPlaceholder =
      previous !== undefined && placeholderOverlayIds.delete(config.overlayId);
    overlayStoreMap.set(
      config.overlayId,
      store as unknown as UseBoundStore<StoreApi<OverlayStoreBase>>,
    );
    if (adoptsPlaceholder) {
      // The stand-in may already have been opened (deep link, contextual
      // automation, a fast user); carry that over instead of resetting the
      // overlay to closed the moment its module finishes loading. Re-creating
      // a real store for the same id deliberately still resets it.
      const { panelOpen, layerVisible, userRevision } = previous.getState();
      store.setState({ panelOpen, layerVisible, userRevision } as Partial<FullState>);
    }
    // Registering (or replacing) a store changes what lookups resolve to, so
    // the effective state may change without any store state transition.
    notifyOverlayChangeListeners();
  }

  return store;
}
