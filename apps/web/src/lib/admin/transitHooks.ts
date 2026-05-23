"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEnv } from "@/lib/EnvProvider";

/**
 * React Query hooks for the /admin/transit page.
 *
 * All endpoints live under `/api/data-manager/*` on the BFF and are documented
 * in apps/api/src/routes/data-manager.ts. The BFF gates them with admin
 * session OR service token; we always send credentials so the admin session
 * cookie travels with the request.
 *
 * Refetch cadences are intentionally tiered:
 *   - state: 30s (lock + counts are slow-moving)
 *   - feeds: 60s (table is large; users can refresh manually)
 *   - jobs: 15s (in-flight runs show up promptly)
 *   - job detail: 5s while running, 60s otherwise
 *   - providers: 30s
 */

export interface TransitStateSummary {
  transitousRef: string | null;
  transitousLockedAt: string | null;
  transitousLockedBy: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  currentJob: { jobId: string; startedAt: string } | null;
  feedCount: number;
  feeds: { byRegion: Record<string, number>; byStatus: Record<string, number> };
}

export interface TransitFeed {
  id: string;
  region: string;
  name: string;
  lastFetchedAt: string | null;
  lastImportedAt: string | null;
  hash: string | null;
  validationStatus: string | null;
  validationMessage: string | null;
  status: string;
}

export interface TransitFeedsResponse {
  feeds: TransitFeed[];
  total: number;
  limit: number;
  offset: number;
}

export interface TransitJob {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  triggeredBy: string | null;
  idempotencyKey: string | null;
  metadata: unknown;
}

export interface TransitJobsResponse {
  jobs: TransitJob[];
  total: number;
  limit: number;
  offset: number;
}

export interface TransitJobStage {
  id: string;
  stage: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  message: string | null;
  error: string | null;
  artifacts: unknown;
}

export interface TransitJobDetail extends TransitJob {
  stages: TransitJobStage[];
}

export interface ProviderHealthEntry {
  id: string;
  success: number;
  failure: number;
  emaLatencyMs: number;
  window: Array<{ outcome: "ok" | "error"; at: string; latencyMs: number }>;
  windowFailureRate?: number;
  disabledUntil?: string;
  disabledReason?: string;
  lastFailureAt?: string;
  lastFailureReason?: string;
}

export interface ProviderHealthResponse {
  providers: ProviderHealthEntry[];
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `Request failed (HTTP ${res.status})`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // fall through with default message
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export function useTransitState() {
  const { apiUrl } = useEnv();
  return useQuery<TransitStateSummary>({
    queryKey: ["admin", "transit", "state"],
    queryFn: () =>
      fetch(`${apiUrl}/api/data-manager/transit/state`, { credentials: "include" }).then(
        jsonOrThrow<TransitStateSummary>,
      ),
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
  const { apiUrl } = useEnv();
  const region = filters.region ?? "";
  const status = filters.status ?? "";
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;
  return useQuery<TransitFeedsResponse>({
    queryKey: ["admin", "transit", "feeds", region, status, limit, offset],
    queryFn: () => {
      const params = new URLSearchParams();
      if (region) params.set("region", region);
      if (status) params.set("status", status);
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      return fetch(`${apiUrl}/api/data-manager/transit/feeds?${params.toString()}`, {
        credentials: "include",
      }).then(jsonOrThrow<TransitFeedsResponse>);
    },
    refetchInterval: 60_000,
  });
}

export function useTransitJobs(limit = 20) {
  const { apiUrl } = useEnv();
  return useQuery<TransitJobsResponse>({
    queryKey: ["admin", "transit", "jobs", limit],
    queryFn: () =>
      fetch(`${apiUrl}/api/data-manager/transit/jobs?limit=${limit}`, {
        credentials: "include",
      }).then(jsonOrThrow<TransitJobsResponse>),
    refetchInterval: 15_000,
  });
}

export function useTransitJobDetail(jobId: string | null) {
  const { apiUrl } = useEnv();
  return useQuery<TransitJobDetail>({
    queryKey: ["admin", "transit", "jobs", "detail", jobId],
    enabled: jobId !== null,
    queryFn: () =>
      fetch(`${apiUrl}/api/data-manager/transit/jobs/${jobId}`, { credentials: "include" }).then(
        jsonOrThrow<TransitJobDetail>,
      ),
    // Running jobs poll fast; finished jobs are immutable so the slower
    // cadence below is only a defensive backstop in case a stage updates late.
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.status === "running" ? 5_000 : 60_000;
    },
  });
}

export function useProviderHealth() {
  const { apiUrl } = useEnv();
  return useQuery<ProviderHealthResponse>({
    queryKey: ["admin", "transit", "providers"],
    queryFn: () =>
      fetch(`${apiUrl}/api/data-manager/providers`, { credentials: "include" }).then(
        jsonOrThrow<ProviderHealthResponse>,
      ),
    refetchInterval: 30_000,
  });
}

export interface SyncTransitInput {
  idempotencyKey?: string;
  countries?: string[];
}

export function useSyncTransit() {
  const { apiUrl } = useEnv();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SyncTransitInput = {}) => {
      const res = await fetch(`${apiUrl}/api/data-manager/transit/sync`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return jsonOrThrow<{ jobId?: string; ok?: boolean }>(res);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "transit", "state"] });
      void qc.invalidateQueries({ queryKey: ["admin", "transit", "jobs"] });
    },
  });
}

export function useRestartMotis() {
  const { apiUrl } = useEnv();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/data-manager/transit/restart-motis`, {
        method: "POST",
        credentials: "include",
      });
      return jsonOrThrow<{ ok?: boolean }>(res);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "transit", "state"] });
    },
  });
}

export function useResetProvider() {
  const { apiUrl } = useEnv();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string) => {
      const res = await fetch(
        `${apiUrl}/api/data-manager/providers/${encodeURIComponent(providerId)}/reset`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      return jsonOrThrow<{ ok: boolean; providerId: string }>(res);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "transit", "providers"] });
    },
  });
}
