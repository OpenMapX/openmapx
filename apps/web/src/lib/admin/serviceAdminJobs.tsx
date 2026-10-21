"use client";

import type { ApiClient } from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useAdminJobRegistration } from "./adminJobEffects";
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
  return useCallback(
    ({ client, apiUrl, jobId, effect }) =>
      register({
        client,
        apiUrl,
        jobId,
        onSettled: () => invalidateServiceAdministration(qc, apiUrl, effect),
      }),
    [register, qc],
  );
}
