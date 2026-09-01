"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEnv } from "@/integration-api/runtime/EnvProvider";

/**
 * React Query hooks for the /admin/poi-ingest page.
 *
 * All endpoints live under `/api/data-manager/poi-ingest/*` on the BFF and are
 * documented in apps/api/src/routes/data-manager.ts. The BFF gates them with
 * admin session OR service token; we always send credentials so the admin
 * session cookie travels with the request.
 *
 * Refetch cadences:
 *   - state: 30s (counts + drift are slow-moving)
 *   - sources: 30s
 *   - source detail: 5s while an ingest is inflight, 60s otherwise
 */

export interface PoiIngestStateSummary {
  sourcesCount: number;
  byDomain: Record<string, number>;
  byStatus: { active: number; stale: number; failed: number; unknown: number };
  recentFailures: Array<{
    sourceId: string;
    domain: string;
    consecutiveFailures: number;
    lastError: { message: string; stack?: string } | null;
    lastStaticIngestAt: string | null;
    lastLiveIngestAt: string | null;
  }>;
  inflight: Array<{ sourceId: string; kind: string; startedAt: string }>;
  registryCountMatchesUpstream: boolean | "unknown";
  drift?: {
    local: { count: number; hash: string };
    upstream: { count: number; hash: string } | null;
    reason?: string;
  };
}

export interface PoiSourceSummary {
  sourceId: string;
  domain: string;
  name: string;
  kinds: Array<"static" | "live" | "bundled">;
  status: string;
  consecutiveFailures: number;
  lastStaticIngestAt: string | null;
  lastLiveIngestAt: string | null;
  lastStaticRowCount: number | null;
  lastLiveRowCount: number | null;
}

interface PoiSourcesResponse {
  sources: PoiSourceSummary[];
}

export interface PoiSourceDetail {
  source: {
    id: string;
    domain: string;
    name: string;
    stationIdPrefix: string;
    coverage: [number, number, number, number] | null;
    kinds: { static?: { cron: string }; live?: { cron: string }; bundled?: { cron: string } };
  };
  feedState: {
    sourceId: string;
    domain: string;
    status: string;
    consecutiveFailures: number;
    lastStaticIngestAt: string | null;
    lastStaticRowCount: number | null;
    lastStaticHash: string | null;
    lastLiveIngestAt: string | null;
    lastLiveRowCount: number | null;
    lastError: { message: string; stack?: string } | null;
  } | null;
  recentJobs: Array<{
    jobId: string;
    kind: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
  }>;
  inflight: Array<{ kind: string; startedAt: string }>;
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

export function usePoiIngestState() {
  const { apiUrl } = useEnv();
  return useQuery<PoiIngestStateSummary>({
    queryKey: ["admin", "poi-ingest", "state"],
    queryFn: () =>
      fetch(`${apiUrl}/api/data-manager/poi-ingest/state`, { credentials: "include" }).then(
        jsonOrThrow<PoiIngestStateSummary>,
      ),
    refetchInterval: 30_000,
  });
}

export interface PoiSourcesFilters {
  domain?: string;
  status?: string;
}

export function usePoiIngestSources(filters: PoiSourcesFilters) {
  const { apiUrl } = useEnv();
  const domain = filters.domain ?? "";
  const status = filters.status ?? "";
  return useQuery<PoiSourceSummary[]>({
    queryKey: ["admin", "poi-ingest", "sources", domain, status],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (domain) params.set("domain", domain);
      if (status) params.set("status", status);
      const qs = params.toString();
      const url = qs
        ? `${apiUrl}/api/data-manager/poi-ingest/sources?${qs}`
        : `${apiUrl}/api/data-manager/poi-ingest/sources`;
      const res = await fetch(url, { credentials: "include" });
      const body = await jsonOrThrow<PoiSourcesResponse>(res);
      return body.sources;
    },
    refetchInterval: 30_000,
  });
}

export function usePoiIngestSourceDetail(sourceId: string | null) {
  const { apiUrl } = useEnv();
  return useQuery<PoiSourceDetail>({
    queryKey: ["admin", "poi-ingest", "sources", "detail", sourceId],
    enabled: sourceId !== null,
    queryFn: () =>
      fetch(`${apiUrl}/api/data-manager/poi-ingest/sources/${encodeURIComponent(sourceId ?? "")}`, {
        credentials: "include",
      }).then(jsonOrThrow<PoiSourceDetail>),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && data.inflight.length > 0 ? 5_000 : 60_000;
    },
  });
}

export interface TriggerPoiIngestInput {
  sourceId: string;
  liveOnly?: boolean;
  idempotencyKey?: string;
}

export interface TriggerPoiIngestResult {
  ok: boolean;
  jobId?: string;
  kind?: string;
  status?: string;
}

export function useTriggerPoiIngest() {
  const { apiUrl } = useEnv();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: TriggerPoiIngestInput) => {
      const path = input.liveOnly
        ? `/api/data-manager/poi-ingest/sources/${encodeURIComponent(input.sourceId)}/sync-live`
        : `/api/data-manager/poi-ingest/sources/${encodeURIComponent(input.sourceId)}/sync`;
      const res = await fetch(`${apiUrl}${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: input.idempotencyKey }),
      });
      return jsonOrThrow<TriggerPoiIngestResult>(res);
    },
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ["admin", "poi-ingest", "state"] });
      void qc.invalidateQueries({ queryKey: ["admin", "poi-ingest", "sources"] });
      void qc.invalidateQueries({
        queryKey: ["admin", "poi-ingest", "sources", "detail", variables.sourceId],
      });
    },
  });
}
