"use client";
import { useContext, useEffect } from "react";
import { AdminDraftContext } from "@/lib/admin/AdminDraftProvider";
import { PLATFORM_SCOPE_FIELDS, type PlatformScope } from "./platformScope";

const entryId = (scope: PlatformScope) => JSON.stringify([`platform:${scope}`, "platform-v1"]);
/** Retained metadata belongs to its ordinary draft, including while its topic is closed. */
export function PlatformPreviewLifecycle({ apiUrl, actorId }: { apiUrl: string; actorId: string }) {
  const store = useContext(AdminDraftContext);
  useEffect(
    () =>
      store?.subscribeDiscard(({ id, reason }) => {
        if (reason === "reauthentication") return;
        for (const scope of Object.keys(PLATFORM_SCOPE_FIELDS) as PlatformScope[])
          if (!id || id === entryId(scope)) {
            try {
              sessionStorage.removeItem(`openmapx-platform-preview:${apiUrl}:${actorId}:${scope}`);
            } catch {
              /* A missing storage area cannot keep a local reviewed form alive. */
            }
          }
      }),
    [store, apiUrl, actorId],
  );
  return null;
}
export function usePlatformPreviewDiscard(scope: PlatformScope, discard: () => void) {
  const store = useContext(AdminDraftContext);
  useEffect(
    () =>
      store?.subscribeDiscard(({ id, reason }) => {
        if (reason !== "reauthentication" && (!id || id === entryId(scope))) discard();
      }),
    [store, scope, discard],
  );
}
