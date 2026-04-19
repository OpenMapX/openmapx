"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEnv } from "@/lib/EnvProvider";

export type ServiceStatus =
  | "running"
  | "exited"
  | "restarting"
  | "created"
  | "paused"
  | "not-running";

export type ServiceQuality = "built-in" | "community-verified" | "community";

export interface ServiceSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  quality: ServiceQuality;
  provides: string[];
  consumes?: Array<{ type: string; mountAt: string; readOnly?: boolean; required?: boolean }>;
  exposure?: {
    hostPorts?: Array<{ container: number; host: number; protocol?: string }>;
    proxy?: { enabled: boolean; pathPrefix?: string };
  };
  enabled: boolean;
  isBuiltIn: boolean;
  status: ServiceStatus;
}

export interface ServiceManifestShape {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  documentation?: string;
  quality: ServiceQuality;
  platform?: string;
  container: {
    image: string;
    tag: string;
    expose?: number[];
    command?: string[] | string;
    entrypoint?: string[] | string;
    environment?: Record<string, string>;
    workingDir?: string;
    user?: string;
    shmSize?: string;
    capAdd?: string[];
    capDrop?: string[];
    devices?: string[];
    privileged?: boolean;
    networkMode?: string;
    memory?: string;
    restart?: string;
    healthcheck?: Record<string, unknown>;
    dependsOn?: Array<{ service: string; condition?: string }>;
    logging?: { driver: string; options?: Record<string, string> };
  };
  provides?: string[];
  consumes?: Array<{ type: string; mountAt: string; readOnly?: boolean; required?: boolean }>;
  produces?: Array<{ type: string; sourceDir: string }>;
  configSchema?: Record<string, unknown>;
  envVars?: Array<{ name: string; required?: boolean; description?: string; default?: string }>;
  volumes?: Array<{ name: string; mountAt: string; readOnly?: boolean; backup?: boolean }>;
  bindMounts?: Array<{ source: string; target: string; readOnly?: boolean }>;
  exposure?: {
    hostPorts?: Array<{ container: number; host: number; protocol?: string; bindAddress?: string }>;
    proxy?: {
      enabled: boolean;
      pathPrefix?: string;
      stripPrefix?: boolean;
      middleware?: string[];
      authRequired?: boolean;
      priority?: number;
    };
  };
  buildCommand?: string;
  ui?: { icon?: string; category?: string };
}

export interface ServiceDetail {
  manifest: ServiceManifestShape;
  directory: string;
  isBuiltIn: boolean;
  enabled: boolean;
  status: ServiceStatus;
}

export type ServiceAction = "start" | "stop" | "restart";

/**
 * The backend enqueues service lifecycle actions via the job runner and returns
 * the job id immediately. Poll admin job endpoints (or refetch services status)
 * to observe progress. `ok: true` means the job was accepted, not that the
 * container transitioned — that is reflected asynchronously in the status field.
 */
export interface ActionResult {
  ok: boolean;
  jobId?: string;
}

export interface ServicesListSummary {
  running: number;
  stopped: number;
  total: number;
}

export interface ServicesListResponse {
  services: ServiceSummary[];
  summary: ServicesListSummary;
}

export function useServicesList() {
  const env = useEnv();
  const apiUrl = env.apiUrl;

  return useQuery<ServicesListResponse>({
    queryKey: ["admin", "services"],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/services`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load services");
      return res.json();
    },
  });
}

export function useServiceDetail(id: string) {
  const env = useEnv();
  const apiUrl = env.apiUrl;

  return useQuery<ServiceDetail>({
    queryKey: ["admin", "services", id],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/services/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load service details");
      return res.json();
    },
    enabled: Boolean(id),
  });
}

export interface ServiceConfigResponse {
  schema: Record<string, unknown> | null;
  config: Record<string, unknown>;
}

/**
 * Fetch the per-service operator config + the manifest's configSchema. The
 * schema can also be reached via `useServiceDetail(id)`, but this endpoint is
 * cheaper for the config tab and avoids re-fetching the full LoadedService.
 */
export function useServiceConfig(id: string) {
  const env = useEnv();
  const apiUrl = env.apiUrl;

  return useQuery<ServiceConfigResponse>({
    queryKey: ["admin", "services", id, "config"],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/services/${id}/config`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load service config");
      return res.json();
    },
    enabled: Boolean(id),
  });
}

export function useServiceConfigSave(id: string) {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  const qc = useQueryClient();

  return useMutation<{ ok: boolean }, Error, Record<string, unknown>>({
    mutationFn: async (config) => {
      const res = await fetch(`${apiUrl}/api/admin/services/${id}/config`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string })?.error ?? "Failed to save config");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "services", id, "config"] });
    },
  });
}

export function useServiceAction(id: string) {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  const qc = useQueryClient();

  return useMutation<ActionResult, Error, ServiceAction>({
    mutationFn: async (action) => {
      const res = await fetch(`${apiUrl}/api/admin/services/${id}/action`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string })?.error ?? `Action "${action}" failed`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "services"] });
      qc.invalidateQueries({ queryKey: ["admin", "services", id] });
    },
  });
}
