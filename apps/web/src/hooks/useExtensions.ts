"use client";

import type { ApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type {
  AdminExtensionCatalogQuery,
  AdminExtensionInstallRequest,
} from "@openmapx/core/api-contracts";
import {
  type QueryClient,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useActivityClient } from "@/components/admin/activity/activityQueries";
import { useAdminJobRegistration } from "@/lib/admin/adminJobEffects";
import {
  EXTENSION_RESOLUTION_TIMEOUT_MS,
  type ExtensionAdministrationClient,
  extensionAdminQueries,
  extensionOrThrow,
  invalidateExtensionAdministration,
} from "@/lib/admin/extensionAdmin";

export function useExtensionCatalog(params: AdminExtensionCatalogQuery) {
  const { client, apiUrl } = useActivityClient();
  return useQuery(extensionAdminQueries(client, apiUrl).catalog(params));
}
export function useInstalledExtensions() {
  const { client, apiUrl } = useActivityClient();
  return useQuery(extensionAdminQueries(client, apiUrl).installed());
}
export function useExtensionSources() {
  const { client, apiUrl } = useActivityClient();
  return useQuery(extensionAdminQueries(client, apiUrl).sources());
}
type RemovalOperation = "extension" | "source";
// View/observer disposal must not release an executing request. Each QueryClient
// has its own ephemeral owners; weak keys do not retain disposed client instances.
const removalOwners = new WeakMap<QueryClient, Set<string>>();
function acquireRemoval(
  qc: QueryClient,
  apiUrl: string,
  operation: RemovalOperation,
  target: string,
) {
  let owners = removalOwners.get(qc);
  if (!owners) {
    owners = new Set();
    removalOwners.set(qc, owners);
  }
  const key = JSON.stringify([apiUrl, operation, target]);
  if (owners.has(key)) throw new Error("Removal already pending for this target");
  owners.add(key);
  return () => {
    owners.delete(key);
    if (!owners.size) removalOwners.delete(qc);
  };
}

function useExtensionWrite<T extends object, V = void>(
  run: (client: ApiClient, values: V) => Promise<T>,
  binding?: ExtensionAdministrationClient,
  removal?: { operation: RemovalOperation; target: (values: V) => string },
) {
  const local = useActivityClient();
  const { client, apiUrl } = binding ?? local;
  const qc = useQueryClient();
  const register = useAdminJobRegistration();
  return useMutation({
    mutationKey: removal
      ? ["extension-removal", apiUrl, removal.operation]
      : ["extension-write", apiUrl],
    retry: false,
    mutationFn: async (values: V) => {
      // Essential effects capture execution ownership here and survive view disposal.
      // Acquire synchronously, before request construction/acquisition. A stale UI
      // or another observer cannot send a second request or release the first owner.
      const release = removal
        ? acquireRemoval(qc, apiUrl, removal.operation, removal.target(values))
        : undefined;
      try {
        const result = await run(client, values);
        if ("jobId" in result && typeof result.jobId === "string")
          register({
            client,
            apiUrl,
            jobId: result.jobId,
            onSettled: () => invalidateExtensionAdministration(qc, apiUrl, "components"),
          });
        else await invalidateExtensionAdministration(qc, apiUrl, "snapshot");
        return result;
      } finally {
        release?.();
      }
    },
  });
}
const options = (client: ApiClient) => ({ client, timeoutMs: EXTENSION_RESOLUTION_TIMEOUT_MS });
export function useInstallExtension(binding?: ExtensionAdministrationClient) {
  return useExtensionWrite(
    (client, body: AdminExtensionInstallRequest) =>
      extensionOrThrow(sdk.installAdminExtension(body, options(client))),
    binding,
  );
}
export function usePreviewExtensionInstall(binding?: ExtensionAdministrationClient) {
  const local = useActivityClient();
  const { client, apiUrl } = binding ?? local;
  return useMutation({
    mutationKey: ["extension-preview", apiUrl],
    retry: false,
    mutationFn: (body: AdminExtensionInstallRequest) =>
      extensionOrThrow(sdk.previewAdminExtensionInstall(body, options(client))),
  });
}
export function useUpdateExtension(binding?: ExtensionAdministrationClient) {
  return useExtensionWrite(
    (client, request: { id: string; hostPortConfirmation?: string }) =>
      extensionOrThrow(
        sdk.updateAdminExtension(
          request.id,
          request.hostPortConfirmation === undefined
            ? undefined
            : { hostPortConfirmation: request.hostPortConfirmation },
          options(client),
        ),
      ),
    binding,
  );
}
/** The MutationCache outlives tab observers. Select all removal scopes so raw
 * identity changes are reflected immediately, independently of cache notifications.
 */
function useExtensionRemoval<T extends object>(
  operation: RemovalOperation,
  run: (client: ApiClient, target: string) => Promise<T>,
) {
  const { apiUrl } = useActivityClient();
  const pending = useMutationState({
    filters: { mutationKey: ["extension-removal"], status: "pending" },
    select: (mutation) =>
      [
        mutation.options.mutationKey?.[1],
        mutation.options.mutationKey?.[2],
        mutation.state.variables,
      ] as const,
  });
  const mutation = useExtensionWrite(run, undefined, { operation, target: (value) => value });
  return {
    ...mutation,
    isPendingFor: (target: string) =>
      pending.some(
        ([origin, kind, value]) => origin === apiUrl && kind === operation && value === target,
      ),
  };
}
export function useRemoveExtension() {
  return useExtensionRemoval("extension", (client, id) =>
    extensionOrThrow(sdk.removeAdminExtension(id, undefined, options(client))),
  );
}
export function useRefreshExtensionCatalog() {
  return useExtensionWrite((client) =>
    extensionOrThrow(sdk.refreshAdminExtensionCatalog(undefined, options(client))),
  );
}
export function useAddExtensionSource() {
  return useExtensionWrite((client, body: Parameters<typeof sdk.addAdminExtensionSource>[0]) =>
    extensionOrThrow(sdk.addAdminExtensionSource(body, options(client))),
  );
}
export function useRemoveExtensionSource() {
  return useExtensionRemoval("source", (client, url) =>
    extensionOrThrow(sdk.removeAdminExtensionSource({ url }, options(client))),
  );
}
