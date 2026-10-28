"use client";

import type { ApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { AdminServiceAction, AdminServicesBulkAction } from "@openmapx/core/api-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useActivityClient } from "@/components/admin/activity/activityQueries";
import {
  invalidateServiceAdministration,
  type ServiceAdministrationEffect,
  serviceAdminQueries,
  serviceOrThrow,
} from "@/lib/admin/serviceAdmin";
import { useServiceJobRegistration } from "@/lib/admin/serviceAdminJobs";

export function useServicesList() {
  const { client, apiUrl } = useActivityClient();
  return useQuery(serviceAdminQueries(client, apiUrl).list());
}
export function useServiceDetail(id: string) {
  const { client, apiUrl } = useActivityClient();
  return useQuery({ ...serviceAdminQueries(client, apiUrl).detail(id), enabled: Boolean(id) });
}
export function useServiceConfig(id: string) {
  const { client, apiUrl } = useActivityClient();
  return useQuery({ ...serviceAdminQueries(client, apiUrl).config(id), enabled: Boolean(id) });
}
export function useServiceCredentials(id: string) {
  const { client, apiUrl } = useActivityClient();
  return useQuery({ ...serviceAdminQueries(client, apiUrl).credentials(id), enabled: Boolean(id) });
}
export function useServiceSelection() {
  const { client, apiUrl } = useActivityClient();
  return useQuery(serviceAdminQueries(client, apiUrl).selection());
}

/** Capture the executing client/origin/effect/registration inside mutationFn.
 * Cache effects may finish after view disposal; replacement views own their UI.
 */
function useServiceWrite<T extends object, V = void>(
  effect: ServiceAdministrationEffect,
  run: (client: ApiClient, values: V) => Promise<T>,
) {
  const { client, apiUrl } = useActivityClient();
  const qc = useQueryClient();
  const register = useServiceJobRegistration();
  return useMutation({
    mutationKey: ["service-write", apiUrl, effect],
    retry: false,
    mutationFn: async (values: V) => {
      const result = await run(client, values);
      if ("jobId" in result && typeof result.jobId === "string")
        register({ client, apiUrl, jobId: result.jobId, effect });
      else void invalidateServiceAdministration(qc, apiUrl, effect);
      return result;
    },
  });
}
export function useServiceConfigSave(id: string) {
  return useServiceWrite(
    { kind: "configuration", serviceId: id },
    (client, config: Record<string, unknown>) => {
      const body = sdk.adminServiceConfigUpdateSchema.safeParse({ config });
      if (!body.success) throw new Error("Invalid service configuration");
      return serviceOrThrow(
        sdk.updateAdminServiceConfig(
          id,
          body.data,
          { "idempotency-key": crypto.randomUUID() },
          { client },
        ),
      );
    },
  );
}
export function useServiceAction(id: string) {
  return useServiceWrite(
    { kind: "service", serviceId: id },
    (client, action: AdminServiceAction["action"]) =>
      serviceOrThrow(sdk.runAdminServiceAction(id, { action }, { client })),
  );
}
export function useSetServiceCredential(id: string) {
  return useServiceWrite(
    { kind: "credentials", serviceId: id },
    (client, { key, value }: { key: string; value: string }) =>
      serviceOrThrow(
        sdk.setAdminServiceCredential(
          id,
          key,
          { value },
          { "idempotency-key": crypto.randomUUID() },
          { client },
        ),
      ),
  );
}
export function useDeleteServiceCredential(id: string) {
  return useServiceWrite({ kind: "credentials", serviceId: id }, (client, key: string) =>
    serviceOrThrow(
      sdk.deleteAdminServiceCredential(
        id,
        key,
        { "idempotency-key": crypto.randomUUID() },
        undefined,
        { client },
      ),
    ),
  );
}
export function useServiceHealthCheck() {
  return useServiceWrite({ kind: "catalog" }, (client) =>
    serviceOrThrow(sdk.checkAdminServices(undefined, { client })),
  );
}
export function useServiceSelectionSave() {
  return useServiceWrite({ kind: "catalog" }, (client, selectedRoots: string[]) =>
    serviceOrThrow(
      sdk.setAdminServiceSelection(
        { selectedRoots },
        { "idempotency-key": crypto.randomUUID() },
        { client },
      ),
    ),
  );
}
export function useServicesBulkAction() {
  return useServiceWrite({ kind: "catalog" }, (client, body: AdminServicesBulkAction) =>
    serviceOrThrow(sdk.runAdminServicesBulkAction(body, { client })),
  );
}
