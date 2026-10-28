"use client";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  createMangroveSigner,
  type MangroveSignerController,
  type SignerSnapshot,
  type SignerTransport,
} from "./signer";

const Context = createContext<{ controller: MangroveSignerController | null; enabled: boolean }>({
  controller: null,
  enabled: false,
});
const FALLBACK: SignerSnapshot = {
  mode: "local",
  status: "disconnected",
  account: null,
  config: { configured: false },
};
const SIGNER_FALLBACK: SignerSnapshot = { ...FALLBACK, mode: "signer", config: null };
const getSignerFallback = () => SIGNER_FALLBACK;
const subscribeEmpty = () => () => {};
const getFallback = () => FALLBACK;
export function MangroveSignerProvider({
  owner,
  transport,
  children,
}: {
  owner: string | null;
  transport?: SignerTransport;
  children: ReactNode;
}) {
  const controller = useMemo(
    () =>
      owner && transport && typeof window !== "undefined"
        ? createMangroveSigner({
            owner,
            transport,
            origin: window.location.origin,
            storage: window.sessionStorage,
          })
        : null,
    [owner, transport],
  );
  useLayoutEffect(() => {
    if (!controller) return;
    controller.activate();
    return () => controller.dispose();
  }, [controller]);
  useEffect(() => {
    void controller?.restore().catch(() => undefined);
  }, [controller]);
  return (
    <Context.Provider value={{ controller, enabled: !!transport }}>{children}</Context.Provider>
  );
}
export function useMangroveSigner() {
  const { controller, enabled } = useContext(Context);
  const fallback = enabled ? getSignerFallback : getFallback;
  const state = useSyncExternalStore(
    controller?.subscribe ?? subscribeEmpty,
    controller?.getSnapshot ?? fallback,
    fallback,
  );
  return { ...state, controller };
}
