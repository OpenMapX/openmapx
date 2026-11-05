"use client";
import { type ApiClient, ApiClientError, useSession } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { PrivacyAdminDetail } from "@openmapx/core/api-contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useActivityClient } from "@/components/admin/activity/activityQueries";
import { useAdminMutationOwner } from "./useAdminMutationOwner";
export type PrivacyMutationIntent = {
  key: string;
  requestId: string;
  version: number;
  kind: string;
};
export type PrivacyMutationHeaders = { "idempotency-key": string };
export const privacyCaseKey = (apiOrigin: string, actorId: string, requestId: string) =>
  ["admin", "privacy", apiOrigin, actorId, "case", requestId] as const;
export async function privacyResult<R extends { status: number; headers: Headers; data: unknown }>(
  pending: Promise<R>,
) {
  return sdk.unwrapAdminResponse(await pending);
}
export function privacyAdminQueries(client: ApiClient, apiOrigin: string, actorId: string) {
  const root = ["admin", "privacy", apiOrigin, actorId] as const;
  const options = (signal: AbortSignal) => ({ client, signal, timeoutMs: 30000 });
  return {
    queue: () =>
      queryOptions({
        queryKey: [...root, "queue"],
        queryFn: ({ signal }) => privacyResult(sdk.listPrivacyAdminQueue(options(signal))),
        enabled: !!actorId,
        retry: false,
      }),
    detail: (requestId: string) =>
      queryOptions({
        queryKey: privacyCaseKey(apiOrigin, actorId, requestId),
        queryFn: async ({ signal }) =>
          sdk.privacyAdminDetailSchema.parse(
            await privacyResult(sdk.getPrivacyAdminCase(requestId, options(signal))),
          ),
        enabled: !!actorId && !!requestId,
        retry: false,
      }),
    readiness: () =>
      queryOptions({
        queryKey: [...root, "readiness"],
        queryFn: ({ signal }) => privacyResult(sdk.getPrivacyAdminReadiness(options(signal))),
        enabled: !!actorId,
        retry: false,
      }),
    backups: () =>
      queryOptions({
        queryKey: [...root, "backups"],
        queryFn: ({ signal }) => privacyResult(sdk.listPrivacyAdminBackups(options(signal))),
        enabled: !!actorId,
        retry: false,
      }),
    operators: (cursor?: string) =>
      queryOptions({
        queryKey: [...root, "operators", cursor ?? ""],
        queryFn: ({ signal }) =>
          privacyResult(
            sdk.listPrivacyAdminOperators(
              { limit: 50, ...(cursor ? { cursor } : {}) },
              options(signal),
            ),
          ),
        enabled: !!actorId,
        retry: false,
      }),
    backupReviews: (requestId: string) =>
      queryOptions({
        queryKey: [...privacyCaseKey(apiOrigin, actorId, requestId), "backup-reviews"],
        queryFn: ({ signal }) =>
          privacyResult(sdk.listPrivacyAdminBackupReviews(requestId, options(signal))),
        enabled: !!actorId && !!requestId,
        retry: false,
      }),
    omissions: (requestId: string) =>
      queryOptions({
        queryKey: [...privacyCaseKey(apiOrigin, actorId, requestId), "omissions"],
        queryFn: ({ signal }) =>
          privacyResult(sdk.listPrivacyAdminBackupOmissions(requestId, options(signal))),
        enabled: !!actorId && !!requestId,
        retry: false,
      }),
  };
}
export function usePrivacyAdmin() {
  const { client, apiUrl: apiOrigin } = useActivityClient();
  const { data: session } = useSession();
  const actorId = session?.user.id ?? "";
  const queries = useMemo(
    () => privacyAdminQueries(client, apiOrigin, actorId),
    [client, apiOrigin, actorId],
  );
  return { client, apiOrigin, actorId, queries };
}
export type PrivacyAdminBinding = ReturnType<typeof usePrivacyAdmin>;
export function usePrivacyMutationClient(
  requestId: string,
  version: number,
  binding: PrivacyAdminBinding,
) {
  const qc = useQueryClient(),
    owner = useAdminMutationOwner(
      binding.client,
      `${binding.apiOrigin}\0${binding.actorId}\0${requestId}`,
    );
  const calls = useRef(new Map<string, () => Promise<unknown>>());
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const mutation = useMutation({
    mutationKey: [...privacyCaseKey(binding.apiOrigin, binding.actorId, requestId), "mutation"],
    retry: false,
    mutationFn: async (intent: PrivacyMutationIntent) => {
      const run = calls.current.get(intent.key);
      if (!run) throw Error("Missing confirmed privacy intent");
      return run();
    },
  });
  async function execute<T>(
    kind: string,
    run: (client: ApiClient, headers: PrivacyMutationHeaders) => Promise<T>,
  ): Promise<T | undefined> {
    if (!owner.active || mutation.isPending) return;
    const executingOwner = owner,
      intent: PrivacyMutationIntent = {
        key: `privacy-admin-${crypto.randomUUID()}`,
        requestId: requestId,
        version,
        kind,
      };
    const key = privacyCaseKey(binding.apiOrigin, binding.actorId, intent.requestId);
    setErrorCode(null);
    calls.current.set(intent.key, () =>
      run(executingOwner.client, { "idempotency-key": intent.key }),
    );
    try {
      const result = (await mutation.mutateAsync(intent)) as T;
      await Promise.all([
        qc.invalidateQueries({ queryKey: key }),
        qc.invalidateQueries({
          queryKey: ["admin", "privacy", binding.apiOrigin, binding.actorId, "queue"],
        }),
      ]);
      return executingOwner.active ? result : undefined;
    } catch (error) {
      if (executingOwner.active) {
        const payload =
          error instanceof ApiClientError ? sdk.privacyErrorSchema.safeParse(error.payload) : null;
        setErrorCode(
          payload?.success && "code" in payload.data
            ? (payload.data.code ?? "PRIVACY_ACTION_FAILED")
            : "PRIVACY_ACTION_FAILED",
        );
      }
      await qc.invalidateQueries({ queryKey: key });
      return undefined;
    } finally {
      calls.current.delete(intent.key);
    }
  }
  return {
    refresh: () =>
      qc.invalidateQueries({
        queryKey: privacyCaseKey(binding.apiOrigin, binding.actorId, requestId),
      }),
    execute,
    pending: mutation.isPending,
    errorCode,
    client: binding.client,
    binding,
  };
}
export type PrivacyCaseClient = ReturnType<typeof usePrivacyCaseClient>;

export function usePrivacyCaseClient(detail: PrivacyAdminDetail, binding: PrivacyAdminBinding) {
  return usePrivacyMutationClient(detail.request.id, detail.request.version, binding);
}
