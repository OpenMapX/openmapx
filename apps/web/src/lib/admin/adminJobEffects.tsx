"use client";

import type { ApiClient } from "@openmapx/core";
import type { AdminActivityJobDetail } from "@openmapx/core/api-contracts";
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
  hasUnresolvedJobObservation,
  useActivityClient,
} from "@/components/admin/activity/activityQueries";
import { useAdminDraftAuthority } from "./AdminDraftProvider";
import { useAdminMutationOwner } from "./useAdminMutationOwner";

export interface AcceptedAdminJob {
  client: ApiClient;
  apiUrl: string;
  jobId: string;
  label?: string;
  returnTo?: string;
  kind?: string;
  onSettled: () => void | Promise<void>;
}
export type RegisterAdminJob = (accepted: AcceptedAdminJob) => void;
export interface ObservedAdminJob {
  jobId: string;
  source: "application";
  label: string;
  returnTo?: string;
  kind?: string;
  status: string;
  unresolved: boolean;
  settled: boolean;
}
const Registration = createContext<RegisterAdminJob | null>(null);
const ObservedJobs = createContext<ObservedAdminJob[]>([]);
const terminal = new Set(["success", "failed", "canceled"]);
type Entry = AcceptedAdminJob & {
  owner: ReturnType<typeof useAdminMutationOwner>;
  callbacks: Set<AcceptedAdminJob["onSettled"]>;
  called: Set<AcceptedAdminJob["onSettled"]>;
  status: string;
  unresolved: boolean;
  settled: boolean;
};
/** Navigation disposes views, never accepted work. Retain executing clients and owner fences.
 * Observation deduplicates identities; settlement retains the union of effect callbacks.
 * Completed metadata remains in this session only, independently of the bounded tray UI.
 */
export function AdminJobEffectsProvider({
  children,
  enabled = true,
}: PropsWithChildren<{ enabled?: boolean }>) {
  const { client, apiUrl } = useActivityClient();
  const authority = useAdminDraftAuthority();
  const canObserve = enabled && (!authority.present || authority.owner?.role === "admin");
  const owner = useAdminMutationOwner(client, JSON.stringify([apiUrl, authority.generation]));
  const qc = useQueryClient();
  const [accepted, setAccepted] = useState<Entry[]>([]);
  const current = canObserve ? accepted.filter((job) => job.owner === owner) : [];
  const jobs = current.filter((job) => !job.settled);
  const register = useCallback<RegisterAdminJob>(
    (job) => {
      if (!canObserve || !owner.active || job.apiUrl !== apiUrl) return;
      void qc.invalidateQueries({ queryKey: ["admin", "jobs", "list", apiUrl] });
      setAccepted((previous) => {
        const entries = previous.filter((item) => item.owner === owner);
        const existing = entries.find((item) => item.jobId === job.jobId);
        if (existing) {
          if (existing.callbacks.has(job.onSettled)) return previous;
          return entries.map((item) =>
            item === existing
              ? { ...item, callbacks: new Set([...item.callbacks, job.onSettled]) }
              : item,
          );
        }
        return [
          ...entries,
          {
            ...job,
            owner,
            callbacks: new Set([job.onSettled]),
            called: new Set(),
            status: "queued",
            unresolved: false,
            settled: false,
          },
        ];
      });
    },
    [canObserve, owner, apiUrl, qc],
  );
  const observations = useQueries({
    queries: jobs.map((job) => {
      const options = activityJobQueryOptions(job.client, job.apiUrl, job.jobId, "application");
      return {
        ...options,
        queryFn: async (
          context: QueryFunctionContext<(string | undefined)[]>,
        ): Promise<AdminActivityJobDetail> => {
          if (!options.queryFn) throw new Error("Admin job observation is unavailable");
          const data = await options.queryFn(context);
          if (data.id !== job.jobId || data.source !== "application")
            throw new Error("Admin job response did not match the accepted job");
          return data;
        },
        retry: false,
        refetchInterval: (query: { state: { data?: { status: string; result?: unknown } } }) =>
          query.state.data &&
          terminal.has(query.state.data.status) &&
          !hasUnresolvedJobObservation(query.state.data.result)
            ? false
            : 1_000,
      };
    }),
  });
  useEffect(() => {
    if (!owner.active) return;
    const changes = new Map<string, Pick<Entry, "status" | "unresolved" | "settled">>();
    let settledNow = false;
    for (const [index, job] of jobs.entries()) {
      const observation = observations[index],
        data = observation?.data;
      if (!data && observation?.isError && !job.unresolved)
        changes.set(job.jobId, { status: job.status, unresolved: true, settled: false });
      if (data?.id !== job.jobId || data.source !== "application") continue;
      const unresolved = observation.isError || hasUnresolvedJobObservation(data.result);
      const settled = terminal.has(data.status) && !unresolved;
      if (job.status !== data.status || job.unresolved !== unresolved || job.settled !== settled)
        changes.set(job.jobId, { status: data.status, unresolved, settled });
      if (settled) settledNow = true;
    }
    for (const job of current) {
      if (!job.settled && !changes.get(job.jobId)?.settled) continue;
      for (const callback of job.callbacks) {
        if (job.called.has(callback)) continue;
        job.called.add(callback);
        void callback();
      }
    }
    if (settledNow) void qc.invalidateQueries({ queryKey: ["admin", "jobs", "list", apiUrl] });
    if (changes.size)
      setAccepted((previous) =>
        previous.map((job) =>
          job.owner === owner && changes.has(job.jobId)
            ? { ...job, ...changes.get(job.jobId) }
            : job,
        ),
      );
  }, [current, jobs, observations, qc, apiUrl, owner]);
  const metadata = current.map((job) => ({
    jobId: job.jobId,
    source: "application" as const,
    label: job.label ?? job.jobId,
    returnTo: job.returnTo,
    kind: job.kind,
    status: job.status,
    unresolved: job.unresolved,
    settled: job.settled,
  }));
  return (
    <Registration.Provider value={register}>
      <ObservedJobs.Provider value={metadata}>{children}</ObservedJobs.Provider>
    </Registration.Provider>
  );
}
export function useAdminJobRegistration(): RegisterAdminJob {
  const register = useContext(Registration);
  if (!register) throw new Error("Admin mutations require AdminJobEffectsProvider");
  return register;
}
export function useAdminObservedJobs() {
  return useContext(ObservedJobs);
}

/** Some focused tools also work outside the admin shell with their own retained observer. */
export function useOptionalAdminJobRegistration() {
  return useContext(Registration);
}
