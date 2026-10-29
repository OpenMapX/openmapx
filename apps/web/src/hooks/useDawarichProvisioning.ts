"use client";

import { ApiClientError } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useActivityClient } from "@/components/admin/activity/activityQueries";
import { invalidateServiceAdministration, serviceAdminQueries } from "@/lib/admin/serviceAdmin";

export type {
  AdminDawarichSecretState as ProvisioningSecretState,
  AdminDawarichStatus as ManagedDawarichProvisioningStatus,
} from "@openmapx/core/api-contracts";

export class DawarichProvisioningApiError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DawarichProvisioningApiError";
  }
}

function safeError(error: unknown): DawarichProvisioningApiError {
  const cause =
    error instanceof Error && error.cause instanceof ApiClientError ? error.cause : error;
  if (cause instanceof ApiClientError) {
    const schema =
      cause.status === 409
        ? sdk.adminDawarichBundleConflictSchema
        : cause.status === 422
          ? sdk.adminDawarichInvalidHostSchema
          : cause.status === 503
            ? sdk.adminDawarichUnavailableSchema
            : cause.status === 400
              ? sdk.adminDawarichConfirmationErrorSchema
              : null;
    const parsed = schema?.safeParse(cause.payload);
    if (parsed?.success) return new DawarichProvisioningApiError(parsed.data.code);
  }
  return new DawarichProvisioningApiError("DAWARICH_PROVISIONING_FAILED");
}

export function useDawarichProvisioning() {
  const { client, apiUrl } = useActivityClient();
  const queryClient = useQueryClient();
  const options = serviceAdminQueries(client, apiUrl).dawarich();
  const statusQuery = useQuery({
    ...options,
    queryFn: async (context) => {
      try {
        if (!options.queryFn) throw new Error("Status query unavailable");
        return await options.queryFn(context);
      } catch (error) {
        throw safeError(error);
      }
    },
    staleTime: 10_000,
  });
  async function complete(
    pending: Promise<
      sdk.provisionAdminDawarichResponse | sdk.rotateAdminDawarichOidcSecretResponse
    >,
  ) {
    const effect = { kind: "dawarich" } as const;
    try {
      const status = sdk.unwrapAdminResponse(await pending);
      // Only the status GET owns shared data; mutation snapshots may arrive out of order.
      void invalidateServiceAdministration(queryClient, apiUrl, effect);
      return status;
    } catch (error) {
      throw safeError(error);
    }
  }
  const provision = useMutation({
    retry: false,
    mutationFn: (publicHost: string | undefined) =>
      complete(sdk.provisionAdminDawarich(publicHost ? { publicHost } : {}, { client })),
  });
  const rotate = useMutation({
    retry: false,
    mutationFn: () =>
      complete(
        sdk.rotateAdminDawarichOidcSecret(
          { confirmation: "ROTATE DAWARICH OIDC SECRET" },
          { client },
        ),
      ),
  });
  return { statusQuery, provision, rotate };
}
