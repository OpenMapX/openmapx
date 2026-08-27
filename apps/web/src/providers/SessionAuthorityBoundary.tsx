"use client";

import { type Session, useSession } from "@openmapx/core";
import { createContext, type ReactNode, useContext, useLayoutEffect, useRef } from "react";
import { useAccountSettingsStore } from "@/stores/accountSettingsStore";

type SettledSessionAuthority = {
  authorityKey: string | null;
  data: Session | null;
  isPending: boolean;
};

const SessionAuthorityContext = createContext<SettledSessionAuthority | null>(null);

/** A collision-free identity for one exact authenticated session. */
function sessionAuthorityKey(session: Session | null | undefined): string | null {
  const userId = session?.user?.id;
  const sessionId = session?.session?.id;
  if (!userId || !sessionId) return null;
  return JSON.stringify([userId, sessionId]);
}

/**
 * Remounts private consumers whenever the exact user/session authority changes.
 * This clears component-local state across sign-in, sign-out, and account
 * replacement without depending on a service-worker cache transition.
 */
export function SessionAuthorityBoundary({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  const closeSettings = useAccountSettingsStore((state) => state.close);
  const previousAuthority = useRef<string | null | undefined>(undefined);
  const signedIn = Boolean(session?.user);
  const authorityKey = signedIn ? sessionAuthorityKey(session) : null;

  useLayoutEffect(() => {
    if (isPending) return;
    if (previousAuthority.current !== undefined && previousAuthority.current !== authorityKey) {
      closeSettings();
    }
    previousAuthority.current = authorityKey;
  }, [authorityKey, closeSettings, isPending]);

  // A signed-in response without both exact identifiers is not a safe
  // authority, and a pending refresh must not expose a half-resolved session.
  if (signedIn && (isPending || authorityKey === null)) return null;

  const value: SettledSessionAuthority = signedIn
    ? { authorityKey, data: session ?? null, isPending: false }
    : { authorityKey: null, data: null, isPending };

  return (
    <SessionAuthorityContext.Provider key={authorityKey ?? "anonymous"} value={value}>
      {children}
    </SessionAuthorityContext.Provider>
  );
}

/** Read only the session authority released by SessionAuthorityBoundary. */
export function useSettledSessionAuthority(): SettledSessionAuthority {
  const value = useContext(SessionAuthorityContext);
  if (!value) {
    throw new Error("useSettledSessionAuthority must be used within SessionAuthorityBoundary");
  }
  return value;
}
