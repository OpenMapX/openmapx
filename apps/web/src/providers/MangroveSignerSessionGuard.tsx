"use client";
import { useSession } from "@openmapx/core";
import { clearMangroveSignerStorage } from "@openmapx/mangrove-react";
import { useEffect, useRef } from "react";
/** Observe session replacement even while the private tree is being remounted. */
export function MangroveSignerSessionGuard() {
  const { data, isPending } = useSession();
  const previous = useRef<string | null | undefined>(undefined);
  const owner =
    data?.user?.id && data.session?.id ? JSON.stringify([data.user.id, data.session.id]) : null;
  useEffect(() => {
    if (isPending) return;
    if (owner === null || (previous.current !== undefined && previous.current !== owner))
      clearMangroveSignerStorage(window.sessionStorage);
    previous.current = owner;
  }, [owner, isPending]);
  return null;
}
