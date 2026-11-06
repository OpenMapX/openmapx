"use client";
import Button from "@mui/material/Button";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import { authClient } from "@openmapx/core";
import { useTranslations } from "next-intl";
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
import {
  type AdminDraftDiscardReason,
  type AdminDraftOwner,
  AdminDraftStore,
} from "./adminDraftStore";
export const AdminDraftContext = createContext<AdminDraftStore | null>(null);
type RequestExit = (message: string, reason?: AdminDraftDiscardReason) => Promise<boolean>;
const ExitContext = createContext<RequestExit | null>(null);
const DEFAULT_COPY = {
  title: "Discard unsaved administration changes?",
  ordinary: "Ordinary drafts will be discarded. Stay to review your work first.",
  reauthentication: "The reviewed reauthentication continuation will be retained.",
  stay: "Stay",
  discard: "Discard and continue",
};
export function AdminDraftProvider({
  children,
  copy = DEFAULT_COPY,
}: PropsWithChildren<{ copy?: typeof DEFAULT_COPY }>) {
  const [store] = useState(() => new AdminDraftStore());
  const [reason, setReason] = useState<string | null>(null);
  const pending = useRef<{
    resolve: (choice: boolean) => void;
    reason: AdminDraftDiscardReason;
  } | null>(null);
  const requestExit = useCallback(
    (message: string, reason: AdminDraftDiscardReason = "discard"): Promise<boolean> => {
      if (!store.dirty) return Promise.resolve(true);
      if (pending.current) return Promise.resolve(false);
      setReason(message);
      return new Promise((resolve) => {
        pending.current = { resolve, reason };
      });
    },
    [store],
  );
  const choose = (discard: boolean) => {
    if (discard) store.discard(undefined, undefined, pending.current?.reason);
    pending.current?.resolve(discard);
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
      pending.current?.resolve(false);
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
          <DialogTitle id="admin-draft-exit-title">{copy.title}</DialogTitle>
          <DialogContent>
            <DialogContentText>
              {reason} {copy.ordinary}{" "}
              {pending.current?.reason === "reauthentication" && copy.reauthentication}
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => choose(false)} autoFocus>
              {copy.stay}
            </Button>
            <Button color="warning" onClick={() => choose(true)}>
              {copy.discard}
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
  const t = useTranslations("adminDrafts");
  const copy = {
    title: t("title"),
    ordinary: t("ordinary"),
    reauthentication: t("reauthentication"),
    stay: t("stay"),
    discard: t("discard"),
  };
  return (
    <AdminDraftProvider copy={copy}>
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
const noDirtyDrafts = () => 0;
export function useAdminDraftCount() {
  const store = useContext(AdminDraftContext);
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.dirtyCount ?? noDirtyDrafts,
    noDirtyDrafts,
  );
}

const noopSubscribe = () => () => {};
const emptySnapshot = () => "none";
/** Also fences accepted work when a confirmed session/role replacement retires drafts. */
export function useAdminDraftAuthority() {
  const store = useContext(AdminDraftContext);
  useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.authoritySnapshot ?? emptySnapshot,
    store?.authoritySnapshot ?? emptySnapshot,
  );
  return { present: !!store, owner: store?.authority, generation: store?.generation ?? 0 };
}
