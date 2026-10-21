"use client";

import type { ApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type {
  AdminExtensionCatalogQuery,
  AdminExtensionInstallRequest,
} from "@openmapx/core/api-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
function useExtensionWrite<T extends object, V = void>(
  run: (client: ApiClient, values: V) => Promise<T>,
  binding?: ExtensionAdministrationClient,
) {
  const local = useActivityClient();
  const { client, apiUrl } = binding ?? local;
  const qc = useQueryClient();
  const register = useAdminJobRegistration();
  return useMutation({
    mutationKey: ["extension-write", apiUrl],
    retry: false,
    mutationFn: async (values: V) => {
      // Essential effects capture execution ownership here and survive view disposal.
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
export function useRemoveExtension() {
  return useExtensionWrite((client, id: string) =>
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
  return useExtensionWrite((client, url: string) =>
    extensionOrThrow(sdk.removeAdminExtensionSource({ url }, options(client))),
  );
}
