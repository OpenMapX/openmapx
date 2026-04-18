"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEnv } from "@/lib/EnvProvider";

export interface RepoRow {
  hash: string;
  url: string;
  displayName: string | null;
  lastFetchedAt: string | null;
  lastSha: string | null;
  autoUpdate: boolean;
  createdAt: string;
}

export interface RepoPreviewService {
  slug: string;
  name: string;
  version: string;
  description?: string;
  quality: string;
  provides: string[];
  needsCapabilities: string[];
  hostPorts: number[];
  proxyEnabled: boolean;
  devices: string[];
  validationErrors: string[];
}

export function useServiceRepos() {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  return useQuery({
    queryKey: ["admin", "service-repos"],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/service-repos`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { repos: RepoRow[] };
    },
  });
}

export function usePreviewRepo() {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  return useMutation({
    mutationFn: async (url: string) => {
      const res = await fetch(`${apiUrl}/api/admin/service-repos/preview`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { hash: string; services: RepoPreviewService[] };
    },
  });
}

export function useAddRepo() {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (url: string) => {
      const res = await fetch(`${apiUrl}/api/admin/service-repos`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, acknowledgeRisks: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "service-repos"] });
      qc.invalidateQueries({ queryKey: ["admin", "services"] });
    },
  });
}

export function useRemoveRepo() {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (hash: string) => {
      const res = await fetch(`${apiUrl}/api/admin/service-repos/${hash}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "service-repos"] });
      qc.invalidateQueries({ queryKey: ["admin", "services"] });
    },
  });
}

export function useRefreshRepo() {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (hash: string) => {
      const res = await fetch(`${apiUrl}/api/admin/service-repos/${hash}/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "service-repos"] });
    },
  });
}
