"use client";

import type { ApiClient } from "@openmapx/core";
import { type QueryFunctionContext, useQueries, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  activityJobQueryOptions,
  useActivityClient,
} from "@/components/admin/activity/activityQueries";
import { invalidateServiceAdministration, type ServiceAdministrationEffect } from "./serviceAdmin";
import { useAdminMutationOwner } from "./useAdminMutationOwner";

export interface AcceptedServiceJob {
  client: ApiClient;
  apiUrl: string;
  jobId: string;
  effect: ServiceAdministrationEffect;
}
export type RegisterServiceJob = (accepted: AcceptedServiceJob) => void;
const Registration = createContext<RegisterServiceJob | null>(null);
const terminal = new Set(["success", "failed", "canceled"]);

/** Mounted at AdminLayout: navigation disposes views, never accepted application work.
 * Register with the callback captured inside the executing mutation. Its provider
 * lifetime fences late acknowledgements after origin replacement (including A→B→A).
 * A hook-local client at the same origin is legitimate: retain that executing client.
 */
export function ServiceAdministrationProvider({ children }: PropsWithChildren) {
  const { client, apiUrl } = useActivityClient();
  const owner = useAdminMutationOwner(client, apiUrl);
  const qc = useQueryClient();
  const [accepted, setAccepted] = useState<(AcceptedServiceJob & { owner: typeof owner })[]>([]);
  const jobs = accepted.filter((job) => job.owner === owner);
  const register = useCallback<RegisterServiceJob>(
    (job) => {
      if (!owner.active || job.apiUrl !== apiUrl) return;
      void qc.invalidateQueries({ queryKey: ["admin", "jobs", "list", apiUrl] });
      setAccepted((current) => [
        ...current.filter((previous) => previous.owner === owner),
        { ...job, owner },
      ]);
    },
    [owner, apiUrl, qc],
  );
  const observations = useQueries({
    queries: jobs.map((job) => {
      const options = activityJobQueryOptions(job.client, job.apiUrl, job.jobId, "application");
      return {
        ...options,
        queryFn: async (context: QueryFunctionContext<(string | undefined)[]>) => {
          if (!options.queryFn) throw new Error("Service job observation is unavailable");
          const data = await options.queryFn(context);
          if (data.id !== job.jobId || data.source !== "application")
            throw new Error("Service job response did not match the accepted job");
          return data;
        },
        retry: false,
        refetchInterval: (query: { state: { data?: { status: string } } }) =>
          query.state.data && terminal.has(query.state.data.status) ? false : 1_000,
      };
    }),
  });
  useEffect(() => {
    const finished = jobs.filter((job, index) => {
      const data = observations[index]?.data;
      return data?.id === job.jobId && data.source === "application" && terminal.has(data.status);
    });
    if (!finished.length) return;
    for (const job of finished) void invalidateServiceAdministration(qc, job.apiUrl, job.effect);
    void qc.invalidateQueries({ queryKey: ["admin", "jobs", "list", apiUrl] });
    setAccepted((current) => current.filter((job) => !finished.includes(job)));
  }, [jobs, observations, qc, apiUrl]);
  return <Registration.Provider value={register}>{children}</Registration.Provider>;
}
export function useServiceJobRegistration(): RegisterServiceJob {
  const register = useContext(Registration);
  if (!register) throw new Error("Service mutations require ServiceAdministrationProvider");
  return register;
}
