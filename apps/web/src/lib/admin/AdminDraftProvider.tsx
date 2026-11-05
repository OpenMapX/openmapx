"use client";
import Button from "@mui/material/Button";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import { authClient } from "@openmapx/core";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Dialog from "@/components/ui/Dialog";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { consumeAdminDocumentExitAllowance } from "./adminDocumentExit";
import { type AdminDraftOwner, AdminDraftStore } from "./adminDraftStore";
export const AdminDraftContext = createContext<AdminDraftStore | null>(null);
const ExitContext = createContext<((reason: string) => Promise<boolean>) | null>(null);
export function AdminDraftProvider({ children }: PropsWithChildren) {
  const [store] = useState(() => new AdminDraftStore());
  const [reason, setReason] = useState<string | null>(null);
  const pending = useRef<((choice: boolean) => void) | null>(null);
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const requestExit = useCallback(
    (message: string): Promise<boolean> => {
      if (!store.dirty) return Promise.resolve(true);
      if (pending.current) return Promise.resolve(false);
      setReason(message);
      return new Promise((resolve) => {
        pending.current = resolve;
      });
    },
    [store],
  );
  const choose = (discard: boolean) => {
    if (discard) store.discard();
    pending.current?.(discard);
    pending.current = null;
    setReason(null);
  };
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (consumeAdminDocumentExitAllowance() || !store.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      pending.current?.(false);
    };
  }, [store]);
  return (
    <AdminDraftContext.Provider value={store}>
      <ExitContext.Provider value={requestExit}>
        {children}
        <Dialog
          open={reason !== null}
          onClose={() => choose(false)}
          aria-labelledby="admin-draft-exit-title"
        >
          <DialogTitle id="admin-draft-exit-title">
            Discard unsaved administration changes?
          </DialogTitle>
          <DialogContent>
            <DialogContentText>
              {reason} Ordinary drafts will be discarded. Stay to save them first.
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => choose(false)} autoFocus>
              Stay
            </Button>
            <Button color="warning" onClick={() => choose(true)}>
              Discard and continue
            </Button>
          </DialogActions>
        </Dialog>
      </ExitContext.Provider>
    </AdminDraftContext.Provider>
  );
}
function AuthorityObserver() {
  const store = useContext(AdminDraftContext);
  const { apiUrl } = useEnv();
  const { data, isPending, error } = authClient.useSession();
  useLayoutEffect(() => {
    store?.setOrigin(apiUrl);
    store?.observeSession({ data, isPending, error });
  }, [store, apiUrl, data, isPending, error]);
  return null;
}
/** Must stay outside SessionAuthorityBoundary, including its pending refresh gate. */
export function AdminDraftRoot({ children }: PropsWithChildren) {
  return (
    <AdminDraftProvider>
      <AuthorityObserver />
      {children}
    </AdminDraftProvider>
  );
}
export function useBindAdminDraftOwner({ apiUrl, actorId, role }: AdminDraftOwner) {
  const store = useContext(AdminDraftContext);
  useLayoutEffect(() => {
    store?.bind({ apiUrl, actorId, role });
  }, [store, apiUrl, actorId, role]);
}
export function useAdminDraftExit() {
  const request = useContext(ExitContext);
  return request ?? (() => Promise.resolve(true));
}

const noopSubscribe = () => () => {};
const emptySnapshot = () => 0;
/** Also fences accepted work when a confirmed session/role replacement retires drafts. */
export function useAdminDraftAuthority() {
  const store = useContext(AdminDraftContext);
  useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.snapshot ?? emptySnapshot,
    store?.snapshot ?? emptySnapshot,
  );
  return { present: !!store, owner: store?.authority, generation: store?.generation ?? 0 };
}
