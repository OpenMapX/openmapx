"use client";
import { useSession } from "@openmapx/core";
import { useEffect, useRef } from "react";
import { clearSignOutWebStorage } from "@/lib/signOutStorage";
/** Observe session replacement even while the private tree is being remounted. */
export function MangroveSignerSessionGuard() {
  const { data, isPending } = useSession();
  const previous = useRef<string | null | undefined>(undefined);
  const owner =
    data?.user?.id && data.session?.id ? JSON.stringify([data.user.id, data.session.id]) : null;
  useEffect(() => {
    if (isPending) return;
    if (owner === null || (previous.current !== undefined && previous.current !== owner))
      clearSignOutWebStorage();
    previous.current = owner;
  }, [owner, isPending]);
  return null;
}
