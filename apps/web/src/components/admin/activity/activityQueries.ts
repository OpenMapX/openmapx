"use client";

import { type ApiClient, createApiClient } from "@openmapx/core";
import { getAdminActivityJob, unwrapAdminResponse } from "@openmapx/core/api-admin-sdk";
import type { AdminActivityJobDetail, AdminActivityJobSource } from "@openmapx/core/api-contracts";
import { queryOptions } from "@tanstack/react-query";
import { useMemo } from "react";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { browserAdminApiBase } from "@/lib/admin/browserAdminApiBase";

/** JSON reads are finite; this deadline never owns a native EventSource. */
export const ACTIVITY_READ_TIMEOUT_MS = 30_000;

export function useActivityClient() {
  const { apiUrl } = useEnv();
  const client = useMemo(
    () => createApiClient({ baseUrl: browserAdminApiBase(apiUrl), credentials: "include" }),
    [apiUrl],
  );
  return { apiUrl, client };
}

export function activityJobQueryOptions(
  client: ApiClient,
  apiUrl: string,
  id: string | undefined,
  source: AdminActivityJobSource,
) {
  return queryOptions({
    queryKey: ["admin", "jobs", "detail", apiUrl, source, id],
    enabled: Boolean(id),
    queryFn: async ({ signal }): Promise<AdminActivityJobDetail> => {
      if (!id) throw new Error("No job selected");
      return unwrapAdminResponse(
        await getAdminActivityJob(
          id,
          { source },
          { client, signal, timeoutMs: ACTIVITY_READ_TIMEOUT_MS },
        ),
      );
    },
  });
}
