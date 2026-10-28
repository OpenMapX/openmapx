"use client";

import type { ApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { AdminIntegrationCredential } from "@openmapx/core/api-contracts";
import {
  type QueryClient,
  type QueryFunctionContext,
  queryOptions,
  useMutation,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  activityJobQueryOptions,
  useActivityClient,
} from "@/components/admin/activity/activityQueries";
import { invalidateIntegrationRuntime } from "@/lib/integrationRuntimeQuery";

import { integrationErrorMessage } from "./integrationErrors";

export { integrationErrorMessage } from "./integrationErrors";

export const INTEGRATION_READ_TIMEOUT_MS = 30_000;
const terminal = new Set(["success", "failed", "canceled"]);

export async function integrationOrThrow<
  R extends { status: number; headers: Headers; data: unknown },
>(pending: Promise<R>) {
  try {
    return sdk.unwrapAdminResponse(await pending);
  } catch (error) {
    throw new Error(integrationErrorMessage(error, "Integration request failed"), { cause: error });
  }
}

export function integrationAdminQueries(client: ApiClient, apiUrl: string) {
  const options = (signal: AbortSignal) => ({
    client,
    signal,
    timeoutMs: INTEGRATION_READ_TIMEOUT_MS,
  });
  const key = ["admin", "integrations", apiUrl] as const;
  return {
    list: () =>
      queryOptions({
        queryKey: [...key, "list"],
        queryFn: ({ signal }) => integrationOrThrow(sdk.listAdminIntegrations(options(signal))),
      }),
    detail: (id: string) =>
      queryOptions({
        queryKey: [...key, "detail", id],
        queryFn: async ({ signal }) =>
          sdk.adminIntegrationDetailSchema.parse(
            await integrationOrThrow(sdk.getAdminIntegration(id, options(signal))),
          ),
      }),
    envVars: () =>
      queryOptions({
        queryKey: [...key, "env-vars"],
        queryFn: ({ signal }) =>
          integrationOrThrow(sdk.listAdminIntegrationEnvVars(options(signal))),
      }),
    bindings: (id: string) =>
      queryOptions({
        queryKey: [...key, "bindings", id],
        queryFn: ({ signal }) =>
          integrationOrThrow(sdk.listAdminIntegrationBindings(id, options(signal))),
      }),
    health: (id: string) =>
      queryOptions({
        queryKey: [...key, "health", id],
        // This GET runs a check; an explicit user action must execute once.
        retry: false,
        queryFn: ({ signal }) =>
          integrationOrThrow(sdk.getAdminIntegrationHealth(id, options(signal))),
      }),
    healthHistory: (id: string, hours: number) =>
      queryOptions({
        queryKey: [...key, "health-history", id, hours],
        queryFn: ({ signal }) =>
          integrationOrThrow(sdk.getAdminIntegrationHealthHistory(id, { hours }, options(signal))),
      }),
    credentials: () =>
      queryOptions({
        queryKey: ["admin", "credentials", apiUrl],
        queryFn: ({ signal }) => integrationOrThrow(sdk.listAdminCredentials(options(signal))),
      }),
    overview: () =>
      queryOptions({
        queryKey: ["admin", "overview", apiUrl],
        queryFn: ({ signal }) => integrationOrThrow(sdk.getAdminOverview(options(signal))),
      }),
    exportConfigs: () =>
      queryOptions({
        queryKey: [...key, "export"],
        staleTime: 0,
        queryFn: ({ signal }) =>
          integrationOrThrow(sdk.exportAdminIntegrationConfigs(options(signal))),
      }),
  };
}

export function invalidateIntegrationAdmin(client: QueryClient, apiUrl: string) {
  return Promise.all([
    client.invalidateQueries({ queryKey: ["admin", "integrations", apiUrl] }),
    client.invalidateQueries({ queryKey: ["admin", "credentials", apiUrl] }),
    client.invalidateQueries({ queryKey: ["admin", "overview", apiUrl] }),
    invalidateIntegrationRuntime(client, apiUrl),
  ]);
}

export function useIntegrationAdmin() {
  const { apiUrl, client } = useActivityClient();
  const qc = useQueryClient();
  return useMemo(
    () => ({
      apiUrl,
      client,
      queries: integrationAdminQueries(client, apiUrl),
      refresh: () => invalidateIntegrationAdmin(qc, apiUrl),
      toggle: (id: string, enabled: boolean) =>
        integrationOrThrow(
          enabled
            ? sdk.enableAdminIntegration(
                id,
                { "idempotency-key": crypto.randomUUID() },
                undefined,
                { client },
              )
            : sdk.disableAdminIntegration(
                id,
                { "idempotency-key": crypto.randomUUID() },
                undefined,
                { client },
              ),
        ),
      healthSweep: () =>
        integrationOrThrow(sdk.runAdminIntegrationHealthChecks(undefined, { client })),
      patchConfig: (id: string, updates: Record<string, unknown>) =>
        integrationOrThrow(
          sdk.patchAdminIntegrationConfig(
            id,
            sdk.adminIntegrationConfigPatchSchema.parse(updates),
            { "idempotency-key": crypto.randomUUID() },
            { client },
          ),
        ),
      setCredential: (id: string, key: string, value: string) =>
        integrationOrThrow(
          sdk.setAdminIntegrationCredential(
            id,
            key,
            { value },
            { "idempotency-key": crypto.randomUUID() },
            { client },
          ),
        ),
      deleteCredential: (id: string, key: string) =>
        integrationOrThrow(
          sdk.deleteAdminIntegrationCredential(
            id,
            key,
            { "idempotency-key": crypto.randomUUID() },
            undefined,
            { client },
          ),
        ),
      setBinding: (id: string, capability: string, serviceId: string | null) =>
        integrationOrThrow(
          serviceId === null
            ? sdk.deleteAdminIntegrationBinding(id, capability, undefined, { client })
            : sdk.setAdminIntegrationBinding(id, capability, { serviceId }, { client }),
        ),
      importConfigs: async (input: unknown) => {
        const parsed = sdk.adminIntegrationConfigImportSchema.safeParse(input);
        if (!parsed.success)
          throw new Error(
            "Import failed — check the file format, integration IDs and config objects. The file must contain at least one unique integration and only supported fields.",
          );
        try {
          return await integrationOrThrow(
            sdk.importAdminIntegrationConfigs(
              parsed.data,
              { "idempotency-key": crypto.randomUUID() },
              { client },
            ),
          );
        } finally {
          void invalidateIntegrationAdmin(qc, apiUrl);
        }
      },
    }),
    [client, apiUrl, qc],
  );
}

/** Audit belongs to the vault even when env/config.json wins the effective value. */
export function hasVaultCredential(credential: AdminIntegrationCredential): boolean {
  return credential.source === "vault" || credential.updatedAt !== undefined;
}

/** Poll the existing Activity SDK; aborting observation never cancels the host job. */
export function useIntegrationReload(id?: string) {
  const { apiUrl, client } = useActivityClient();
  const qc = useQueryClient();
  const [accepted, setAccepted] = useState<{ client: ApiClient; id: string }[]>([]);
  const jobs = accepted.filter((job) => job.client === client);
  const observations = useQueries({
    queries: jobs.map(({ id: jobId }) => {
      const options = activityJobQueryOptions(client, apiUrl, jobId, "application");
      return {
        ...options,
        queryFn: async (context: QueryFunctionContext<(string | undefined)[]>) => {
          if (!options.queryFn) throw new Error("Reload observation is unavailable");
          const data = await options.queryFn(context);
          if (data.id !== jobId || data.source !== "application")
            throw new Error("Reload job response did not match the accepted job");
          return data;
        },
        retry: false,
        refetchInterval: (query: { state: { data?: { status: string } } }) =>
          query.state.data && terminal.has(query.state.data.status) ? false : 1_000,
      };
    }),
  });
  useEffect(() => {
    const finished = jobs.filter((job, index) => {
      const data = observations[index]?.data;
      return data?.id === job.id && data.source === "application" && terminal.has(data.status);
    });
    if (!finished.length) return;
    void invalidateIntegrationAdmin(qc, apiUrl);
    setAccepted((current) => current.filter((job) => !finished.includes(job)));
  }, [jobs, observations, qc, apiUrl]);
  return useMutation({
    mutationKey: ["integration-reload", apiUrl, id],
    retry: false,
    mutationFn: async () => {
      // Capture ownership in the executing request, not a callback whose options
      // may be replaced by a render for a different API origin while it waits.
      const acceptance = await integrationOrThrow(
        id === undefined
          ? sdk.reloadAdminIntegrations(undefined, { client })
          : sdk.reloadAdminIntegration(id, undefined, { client }),
      );
      setAccepted((current) => [
        ...current.filter((job) => job.client !== client || job.id !== acceptance.jobId),
        { client, id: acceptance.jobId },
      ]);
      return acceptance;
    },
  });
}
