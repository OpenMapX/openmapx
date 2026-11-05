"use client";

import type { ApiClient } from "@openmapx/core";
import { useLayoutEffect, useMemo, useRef } from "react";

/** Keep one pending user intent through transport failure. Acceptance completes
 * it; a later explicit action receives a fresh key. Nothing enters storage. */
export function useAdminMutationKey(client: ApiClient) {
  const current = useRef<{ client: ApiClient; intent: string; key: string } | null>(null);
  return {
    forIntent(intent: string) {
      if (current.current?.client !== client || current.current.intent !== intent)
        current.current = { client, intent, key: crypto.randomUUID() };
      return current.current.key;
    },
    reset() {
      current.current = null;
    },
    complete(key: string) {
      if (current.current?.key === key) current.current = null;
    },
  };
}

/** View effects belong to the executing client/domain and committed component lifetime.
 * Capture this token inside mutationFn (or an event handler), never in hook-level
 * completion options: TanStack replaces those options while requests are pending.
 * Disposal only fences UI effects; it does not cancel the server's mutation.
 */
export function useAdminMutationOwner(client: ApiClient, identity = "") {
  const owner = useMemo(() => ({ active: false, client, identity }), [client, identity]);
  useLayoutEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [owner]);
  return owner;
}
