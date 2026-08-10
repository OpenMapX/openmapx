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
  consumes?: Array<{
    type: string;
    mountAt: string;
    targetFilename?: string;
    readOnly?: boolean;
    required?: boolean;
  }>;
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
  consumes?: Array<{
    type: string;
    mountAt: string;
    targetFilename?: string;
    readOnly?: boolean;
    required?: boolean;
  }>;
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

export type ServiceConfigSource = "default" | "database" | "env";

export interface ResolvedConfigValue {
  value: unknown;
  source: ServiceConfigSource;
}

export interface ServiceConfigResponse {
  schema: Record<string, unknown> | null;
  resolvedConfig: Record<string, ResolvedConfigValue>;
  /** Env-var prefix operators use to override values (e.g. `SERVICE_VALHALLA_`). */
  envPrefix: string;
}

/**
 * Fetch the per-service operator config + the manifest's configSchema. The
 * response is resolved per field (default / database / env), so the config
 * form can show source badges and disable fields currently overridden by
 * host env vars.
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

export interface ServiceCredentialStatus {
  key: string;
  title: string;
  description?: string;
  setup?: import("@openmapx/integration-framework").CredentialSetup;
  source: "vault" | "missing";
  managedBy?: "dawarich-provisioning";
  updatedAt?: string;
  updatedBy?: string | null;
}

export interface ServiceCredentialsResponse {
  serviceId: string;
  secretsConfigured: boolean;
  credentials: ServiceCredentialStatus[];
}

/** Result of a credential set/delete: an apply job was enqueued, or a render is needed. */
export interface ServiceCredentialApplyResult {
  ok: boolean;
  jobId?: string;
  needsRender?: boolean;
}

/** Declared secret fields of a service + per-field vault status. */
export function useServiceCredentials(id: string) {
  const apiUrl = useEnv().apiUrl;

  return useQuery<ServiceCredentialsResponse>({
    queryKey: ["admin", "services", id, "credentials"],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/services/${id}/credentials`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load service credentials");
      return res.json();
    },
    enabled: Boolean(id),
  });
}

export function useSetServiceCredential(id: string) {
  const apiUrl = useEnv().apiUrl;
  const qc = useQueryClient();

  return useMutation<ServiceCredentialApplyResult, Error, { key: string; value: string }>({
    mutationFn: async ({ key, value }) => {
      const res = await fetch(
        `${apiUrl}/api/admin/services/${id}/credentials/${encodeURIComponent(key)}`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string })?.error ?? "Failed to set credential");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "services", id, "credentials"] });
    },
  });
}

export function useDeleteServiceCredential(id: string) {
  const apiUrl = useEnv().apiUrl;
  const qc = useQueryClient();

  return useMutation<ServiceCredentialApplyResult, Error, string>({
    mutationFn: async (key) => {
      const res = await fetch(
        `${apiUrl}/api/admin/services/${id}/credentials/${encodeURIComponent(key)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string })?.error ?? "Failed to delete credential");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "services", id, "credentials"] });
    },
  });
}
