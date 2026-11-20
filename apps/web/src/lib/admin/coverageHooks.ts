"use client";

import { isApiClientError } from "@openmapx/core";
import {
  ApiContractError,
  getAdminCoverageReport,
  getAdminCoverageSource,
  listAdminCoverageRegions,
  unwrapAdminResponse,
} from "@openmapx/core/api-admin-sdk";
import type { CoverageDomain, UsageAssessment } from "@openmapx/core/coverage";
import { useQuery } from "@tanstack/react-query";
import { useActivityClient } from "@/components/admin/activity/activityQueries";

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

/** Coverage failures keep their HTTP status and the stable code the API names in `error`. */
async function unwrapCoverage<R extends { status: number; headers: Headers; data: unknown }>(
  pending: Promise<R>,
) {
  try {
    return unwrapAdminResponse(await pending);
  } catch (error) {
    if (isApiClientError(error)) {
      const code = (error.payload as { error?: unknown } | null)?.error;
      throw requestError(error.status, typeof code === "string" ? code : undefined);
    }
    if (error instanceof ApiContractError) throw requestError(error.status);
    throw error;
  }
}

export function useCoverageRegions(filters: CoverageRegionsFilters = {}) {
  const { client } = useActivityClient();
  const search = filters.search ?? "";
  const snapshotId = filters.snapshotId ?? "";
  const refreshNonce = filters.refreshNonce ?? 0;
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 50;
  return useQuery({
    queryKey: ["admin", "coverage", "regions", search, snapshotId, refreshNonce, offset, limit],
    queryFn: ({ signal }) =>
      unwrapCoverage(
        listAdminCoverageRegions(
          {
            search: search || undefined,
            snapshotId: snapshotId || undefined,
            offset: String(offset),
            limit: String(limit),
          },
          { client, signal },
        ),
      ),
    retry: (count, error) => (error as CoverageRequestError).status >= 500 && count < 1,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useCoverageReport(filters: CoverageReportFilters | null) {
  const { client } = useActivityClient();
  const regionId = filters?.regionId ?? "";
  const snapshotId = filters?.snapshotId ?? "";
  const refreshNonce = filters?.refreshNonce ?? 0;
  const domain = filters?.domain ?? "";
  const attention = filters?.attention ?? false;
  const enabled = filters?.enabled;
  const assessment = filters?.assessment ?? "operational";
  const offset = filters?.offset ?? 0;
  const limit = filters?.limit ?? 50;
  return useQuery({
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
      unwrapCoverage(
        getAdminCoverageReport(
          {
            regionId,
            snapshotId: snapshotId || undefined,
            domain: domain || undefined,
            attention: attention ? "true" : undefined,
            enabled: enabled === undefined ? undefined : enabled ? "true" : "false",
            assessment,
            offset: String(offset),
            limit: String(limit),
          },
          { client, signal },
        ),
      ),
    retry: (count, error) => (error as CoverageRequestError).status >= 500 && count < 1,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useCoverageSource(filters: CoverageSourceFilters | null) {
  const { client } = useActivityClient();
  const key = filters?.key ?? "";
  const regionId = filters?.regionId ?? "";
  const snapshotId = filters?.snapshotId ?? "";
  const assessment = filters?.assessment ?? "operational";
  return useQuery({
    queryKey: ["admin", "coverage", "source", key, regionId, snapshotId, assessment],
    enabled: Boolean(filters?.key && filters?.regionId),
    queryFn: ({ signal }) =>
      unwrapCoverage(
        getAdminCoverageSource(
          { key, regionId, snapshotId: snapshotId || undefined, assessment },
          { client, signal },
        ),
      ),
    retry: (count, error) => (error as CoverageRequestError).status >= 500 && count < 1,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}
