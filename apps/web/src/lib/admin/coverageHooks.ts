"use client";

import type {
  CoverageDomain,
  CoverageRegionsResponse,
  CoverageReport,
  CoverageSourceDetail,
  UsageAssessment,
} from "@openmapx/core/coverage";
import { useQuery } from "@tanstack/react-query";
import { useEnv } from "@/integration-api/runtime/EnvProvider";

export interface CoverageRequestError extends Error {
  status: number;
  code?: string;
}

export interface CoverageReportFilters {
  regionId: string;
  snapshotId?: string;
  refreshNonce?: number;
  domain?: CoverageDomain;
  attention?: boolean;
  enabled?: boolean;
  assessment?: UsageAssessment;
  offset?: number;
  limit?: number;
}

export interface CoverageRegionsFilters {
  snapshotId?: string;
  refreshNonce?: number;
  search?: string;
  offset?: number;
  limit?: number;
}

export interface CoverageSourceFilters {
  key: string;
  regionId: string;
  snapshotId?: string;
  assessment?: UsageAssessment;
}

function requestError(status: number, code?: string): CoverageRequestError {
  const error = new Error(code ?? `Request failed (HTTP ${status})`) as CoverageRequestError;
  error.status = status;
  error.code = code;
  return error;
}

export async function fetchCoverageJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: "include", signal });
  if (!response.ok) {
    let code: string | undefined;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") code = body.error;
    } catch {
      // Keep the HTTP status when the server did not return JSON.
    }
    throw requestError(response.status, code);
  }
  return response.json() as Promise<T>;
}

function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function useCoverageRegions(filters: CoverageRegionsFilters = {}) {
  const { apiUrl } = useEnv();
  const search = filters.search ?? "";
  const snapshotId = filters.snapshotId ?? "";
  const refreshNonce = filters.refreshNonce ?? 0;
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 50;
  return useQuery<CoverageRegionsResponse>({
    queryKey: ["admin", "coverage", "regions", search, snapshotId, refreshNonce, offset, limit],
    queryFn: ({ signal }) =>
      fetchCoverageJson<CoverageRegionsResponse>(
        `${apiUrl}/api/admin/coverage/regions${queryString({
          search: search || undefined,
          snapshotId: snapshotId || undefined,
          offset,
          limit,
        })}`,
        signal,
      ),
    retry: (count, error) => (error as CoverageRequestError).status >= 500 && count < 1,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useCoverageReport(filters: CoverageReportFilters | null) {
  const { apiUrl } = useEnv();
  const regionId = filters?.regionId ?? "";
  const snapshotId = filters?.snapshotId ?? "";
  const refreshNonce = filters?.refreshNonce ?? 0;
  const domain = filters?.domain ?? "";
  const attention = filters?.attention ?? false;
  const enabled = filters?.enabled;
  const assessment = filters?.assessment ?? "operational";
  const offset = filters?.offset ?? 0;
  const limit = filters?.limit ?? 50;
  return useQuery<CoverageReport>({
    queryKey: [
      "admin",
      "coverage",
      "report",
      regionId,
      snapshotId,
      refreshNonce,
      domain,
      attention,
      enabled === undefined ? "all" : enabled,
      assessment,
      offset,
      limit,
    ],
    enabled: Boolean(filters?.regionId),
    queryFn: ({ signal }) =>
      fetchCoverageJson<CoverageReport>(
        `${apiUrl}/api/admin/coverage${queryString({
          regionId,
          snapshotId: snapshotId || undefined,
          domain: domain || undefined,
          attention: attention ? true : undefined,
          enabled,
          assessment,
          offset,
          limit,
        })}`,
        signal,
      ),
    retry: (count, error) => (error as CoverageRequestError).status >= 500 && count < 1,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useCoverageSource(filters: CoverageSourceFilters | null) {
  const { apiUrl } = useEnv();
  const key = filters?.key ?? "";
  const regionId = filters?.regionId ?? "";
  const snapshotId = filters?.snapshotId ?? "";
  const assessment = filters?.assessment ?? "operational";
  return useQuery<CoverageSourceDetail>({
    queryKey: ["admin", "coverage", "source", key, regionId, snapshotId, assessment],
    enabled: Boolean(filters?.key && filters?.regionId),
    queryFn: ({ signal }) =>
      fetchCoverageJson<CoverageSourceDetail>(
        `${apiUrl}/api/admin/coverage/source${queryString({
          key,
          regionId,
          snapshotId: snapshotId || undefined,
          assessment,
        })}`,
        signal,
      ),
    retry: (count, error) => (error as CoverageRequestError).status >= 500 && count < 1,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}
