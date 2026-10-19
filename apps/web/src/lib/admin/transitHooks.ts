"use client";

import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type {
  ProviderHealthEntry,
  ProviderHealthResponse,
  TransitFeed,
  TransitFeedsResponse,
  TransitJob,
  TransitJobDetail,
  TransitJobStage,
  TransitJobsResponse,
  TransitStateSummary,
} from "@openmapx/core/api-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useEnv } from "@/integration-api/runtime/EnvProvider";

/**
 * React Query hooks for the /admin/transit page.
 *
 * All endpoints live under `/api/data-manager/*` on the BFF and are documented
 * in apps/api/src/routes/data-manager.ts. The BFF owns session/service
 * authorization; browser requests send credentials so the admin session
 * cookie travels with the request.
 *
 * Refetch cadences are intentionally tiered:
 *   - state: 30s (lock + counts are slow-moving)
 *   - feeds: 60s (table is large; users can refresh manually)
 *   - jobs: 15s (in-flight runs show up promptly)
 *   - job detail: 5s while running, 60s otherwise
 *   - providers: 30s
 */

export type {
  ProviderHealthEntry,
  ProviderHealthResponse,
  TransitFeed,
  TransitFeedsResponse,
  TransitJob,
  TransitJobDetail,
  TransitJobStage,
  TransitJobsResponse,
  TransitStateSummary,
};

function useAdminClient() {
  const { apiUrl } = useEnv();
  return useMemo(() => createApiClient({ baseUrl: apiUrl, credentials: "include" }), [apiUrl]);
}

async function adminOrThrow<R extends { status: number; headers: Headers; data: unknown }>(
  pending: Promise<R>,
) {
  return sdk.unwrapAdminResponse(await pending);
}

export function useTransitState() {
  const client = useAdminClient();
  return useQuery({
    queryKey: ["admin", "transit", "state"],
    queryFn: ({ signal }) => adminOrThrow(sdk.getApiDataManagerTransitState({ client, signal })),
    refetchInterval: 30_000,
  });
}

export interface TransitFeedsFilters {
  region?: string;
  status?: string;
  limit?: number;
  offset?: number;
}
export function useTransitFeeds(filters: TransitFeedsFilters) {
  const client = useAdminClient();
  const region = filters.region ?? "";
  const status = filters.status ?? "";
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;
  return useQuery({
    queryKey: ["admin", "transit", "feeds", region, status, limit, offset],
    queryFn: ({ signal }) =>
      adminOrThrow(
        sdk.getApiDataManagerTransitFeeds(
          { region: region || undefined, status: status || undefined, limit, offset },
          { client, signal },
        ),
      ),
    refetchInterval: 60_000,
  });
}
export function useTransitJobs(limit = 20) {
  const client = useAdminClient();
  return useQuery({
    queryKey: ["admin", "transit", "jobs", limit],
    queryFn: ({ signal }) =>
      adminOrThrow(sdk.getApiDataManagerTransitJobs({ limit }, { client, signal })),
    refetchInterval: 15_000,
  });
}
export function useTransitJobDetail(jobId: string | null) {
  const client = useAdminClient();
  return useQuery({
    queryKey: ["admin", "transit", "jobs", "detail", jobId],
    enabled: jobId !== null,
    queryFn: ({ signal }) => {
      if (jobId === null) throw new Error("A transit job is required");
      return adminOrThrow(sdk.getApiDataManagerTransitJobsId(jobId, { client, signal }));
    },
    refetchInterval: (query) => (query.state.data?.status === "running" ? 5_000 : 60_000),
  });
}
export function useProviderHealth() {
  const client = useAdminClient();
  return useQuery({
    queryKey: ["admin", "transit", "providers"],
    queryFn: ({ signal }) => adminOrThrow(sdk.getApiDataManagerProviders({ client, signal })),
    refetchInterval: 30_000,
  });
}
export type SyncTransitInput = NonNullable<Parameters<typeof sdk.postApiDataManagerTransitSync>[0]>;
export function useSyncTransit() {
  const client = useAdminClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SyncTransitInput = {}) =>
      adminOrThrow(sdk.postApiDataManagerTransitSync(input, { client })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "transit", "state"] });
      void qc.invalidateQueries({ queryKey: ["admin", "transit", "jobs"] });
    },
  });
}
export function useRestartMotis() {
  const client = useAdminClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => adminOrThrow(sdk.postApiDataManagerTransitRestartMotis({ client })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "transit", "state"] });
    },
  });
}
export function useBumpTransitous() {
  const client = useAdminClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (branch: string) =>
      adminOrThrow(sdk.postApiDataManagerTransitBumpTransitousRef({ branch }, { client })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "transit"] });
    },
  });
}
export function useResetProvider() {
  const client = useAdminClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string) =>
      adminOrThrow(sdk.postApiDataManagerProvidersIdReset(providerId, { client })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "transit", "providers"] });
    },
  });
}
