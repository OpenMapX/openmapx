"use client";

import type { ApiClient } from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { useAdminJobRegistration } from "./adminJobEffects";
import { safeAdminJobReturn } from "./adminJobNavigation";
import { invalidateServiceAdministration, type ServiceAdministrationEffect } from "./serviceAdmin";

export interface AcceptedServiceJob {
  client: ApiClient;
  apiUrl: string;
  jobId: string;
  effect: ServiceAdministrationEffect;
}
export type RegisterServiceJob = (accepted: AcceptedServiceJob) => void;

/** Services own their invalidation graph; the layout owns accepted-job observation. */
export function useServiceJobRegistration(): RegisterServiceJob {
  const register = useAdminJobRegistration();
  const qc = useQueryClient();
  const pathname = usePathname(),
    params = useSearchParams();
  const tab = params?.get("tab");
  const returnTo = pathname
    ? (safeAdminJobReturn(pathname + (tab ? `?${new URLSearchParams({ tab }).toString()}` : "")) ??
      undefined)
    : undefined;
  return useCallback(
    ({ client, apiUrl, jobId, effect }) =>
      register({
        client,
        apiUrl,
        jobId,
        label: "serviceId" in effect ? `${effect.serviceId} · ${effect.kind}` : effect.kind,
        returnTo,
        onSettled: () => invalidateServiceAdministration(qc, apiUrl, effect),
      }),
    [register, qc, returnTo],
  );
}
