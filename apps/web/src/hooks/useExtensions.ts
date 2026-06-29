"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEnv } from "@/lib/EnvProvider";

export interface ExtensionSecurityRating {
  score: number;
  requiresBuiltIn: boolean;
  hostPorts: number;
  secretCount: number;
  factors: string[];
}

export interface ExtensionCatalogView {
  id: string;
  name: string;
  summary?: string;
  description?: string;
  author?: string;
  homepage?: string;
  icon?: string;
  screenshots?: string[];
  categories?: string[];
  tags?: string[];
  /** Resolved live from the manifest; absent if the manifest fetch failed. */
  version?: string;
  minPlatform?: string;
  lastUpdated?: string;
  trust?: "built-in" | "verified" | "community";
  featured?: boolean;
  components: { services: number; integrations: number };
  compatible: boolean;
  platformVersion: string;
  installed: boolean;
  installedVersion: string | null;
  hasUpdate: boolean;
  removed: string | null;
  critical: { reason: string; maxVersion?: string } | null;
}

export interface InstalledExtensionComponentView {
  kind: string;
  componentId: string;
  enabled?: boolean;
  securityRating?: ExtensionSecurityRating;
}

export interface InstalledExtensionView {
  id: string;
  name: string;
  sourceTrust: string;
  installedVersion: string;
  sourceUrl: string | null;
  installedAt: string;
  updatedAt: string;
  components: InstalledExtensionComponentView[];
  hasUpdate: boolean;
  latestVersion: string | null;
}

export interface ExtensionSource {
  url: string;
  label: string;
  isDefault: boolean;
}

const CATALOG_KEY = ["admin", "extensions", "catalog"];
const INSTALLED_KEY = ["admin", "extensions", "installed"];
const SOURCES_KEY = ["admin", "extensions", "sources"];

export function useExtensionCatalog(params: { q?: string; trust?: string; type?: string }) {
  const { apiUrl } = useEnv();
  return useQuery({
    queryKey: [...CATALOG_KEY, params],
    queryFn: async () => {
      const sp = new URLSearchParams();
      if (params.q) sp.set("q", params.q);
      if (params.trust) sp.set("trust", params.trust);
      if (params.type) sp.set("type", params.type);
      const res = await fetch(`${apiUrl}/api/admin/extensions/catalog?${sp}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { entries: ExtensionCatalogView[]; total: number };
    },
  });
}

export function useInstalledExtensions() {
  const { apiUrl } = useEnv();
  return useQuery({
    queryKey: INSTALLED_KEY,
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/extensions/installed`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { extensions: InstalledExtensionView[] };
    },
  });
}

export function useExtensionSources() {
  const { apiUrl } = useEnv();
  return useQuery({
    queryKey: SOURCES_KEY,
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/extensions/sources`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { sources: ExtensionSource[] };
    },
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: CATALOG_KEY });
    qc.invalidateQueries({ queryKey: INSTALLED_KEY });
  };
}

export function useInstallExtension() {
  const { apiUrl } = useEnv();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (body: { id?: string; manifestUrl?: string }) => {
      const res = await fetch(`${apiUrl}/api/admin/extensions/install`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      return data as { jobId: string };
    },
    onSuccess: invalidate,
  });
}

export function useUpdateExtension() {
  const { apiUrl } = useEnv();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${apiUrl}/api/admin/extensions/update/${id}`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      return data as { jobId: string };
    },
    onSuccess: invalidate,
  });
}

export function useRemoveExtension() {
  const { apiUrl } = useEnv();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${apiUrl}/api/admin/extensions/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      return data as { jobId: string };
    },
    onSuccess: invalidate,
  });
}

export function useRefreshExtensionCatalog() {
  const { apiUrl } = useEnv();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/extensions/refresh-catalog`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { entries: number };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: CATALOG_KEY }),
  });
}

export function useAddExtensionSource() {
  const { apiUrl } = useEnv();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { url: string; label: string }) => {
      const res = await fetch(`${apiUrl}/api/admin/extensions/sources`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SOURCES_KEY });
      qc.invalidateQueries({ queryKey: CATALOG_KEY });
    },
  });
}

export function useRemoveExtensionSource() {
  const { apiUrl } = useEnv();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (url: string) => {
      const res = await fetch(`${apiUrl}/api/admin/extensions/sources`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SOURCES_KEY });
      qc.invalidateQueries({ queryKey: CATALOG_KEY });
    },
  });
}
