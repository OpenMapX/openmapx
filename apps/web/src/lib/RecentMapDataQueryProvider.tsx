"use client";

import { IsRestoringProvider, type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type PersistQueryClientProviderProps,
  persistQueryClientRestore,
} from "@tanstack/react-query-persist-client";
import { useEffect, useRef, useState } from "react";
import { subscribeRecentMapDataPersistence } from "./queryPersistence";

/** Keep TanStack restoration/gating while coalescing saves before dehydration. */
export function RecentMapDataQueryProvider({
  client,
  children,
  persistOptions,
  onSuccess,
  onError,
}: PersistQueryClientProviderProps) {
  const [restoredClient, setRestoredClient] = useState<QueryClient | null>(null);
  const activeClient = useRef<QueryClient | null>(null);
  const restore = useRef<{ client: QueryClient; promise: Promise<void> } | null>(null);
  const callbacks = useRef({ persistOptions, onSuccess, onError });
  const isRestoring = restoredClient !== client;

  useEffect(() => {
    callbacks.current = { persistOptions, onSuccess, onError };
  });

  useEffect(() => {
    let active = true;
    activeClient.current = client;
    const options = { ...callbacks.current.persistOptions, queryClient: client };
    let unsubscribe: (() => void) | undefined;
    if (isRestoring) {
      if (restore.current?.client !== client) {
        const promise = persistQueryClientRestore({
          ...options,
          persister: {
            ...options.persister,
            async restoreClient() {
              const stored = await options.persister.restoreClient();
              // A pending storage read must not hydrate a detached client.
              return activeClient.current === client ? stored : undefined;
            },
          },
        })
          .then(() => {
            if (activeClient.current === client) return callbacks.current.onSuccess?.();
            return undefined;
          })
          .catch(() => {
            if (activeClient.current === client) return callbacks.current.onError?.();
            return undefined;
          })
          .then(() => {});
        restore.current = { client, promise };
      }
      void restore.current.promise.finally(() => {
        if (active) setRestoredClient(client);
      });
    } else {
      unsubscribe = subscribeRecentMapDataPersistence(options);
    }
    return () => {
      active = false;
      if (activeClient.current === client) activeClient.current = null;
      unsubscribe?.();
    };
  }, [client, isRestoring]);

  return (
    <QueryClientProvider client={client}>
      <IsRestoringProvider value={isRestoring}>{children}</IsRestoringProvider>
    </QueryClientProvider>
  );
}
