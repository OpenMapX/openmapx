"use client";

import type { ApiClient } from "@openmapx/core";
import { useLayoutEffect, useMemo } from "react";

/** View effects belong to the executing client/domain and committed component lifetime.
 * Capture this token inside mutationFn (or an event handler), never in hook-level
 * completion options: TanStack replaces those options while requests are pending.
 * Disposal only fences UI effects; it does not cancel the server's mutation.
 */
export function useIntegrationMutationOwner(client: ApiClient, identity = "") {
  const owner = useMemo(() => ({ active: false, client, identity }), [client, identity]);
  useLayoutEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [owner]);
  return owner;
}
