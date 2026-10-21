import { type ApiClient, ApiClientError } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import { type QueryClient, type QueryKey, queryOptions } from "@tanstack/react-query";
import { invalidateIntegrationRuntime } from "@/lib/integrationRuntimeQuery";

export const SERVICE_READ_TIMEOUT_MS = 30_000;

/** Only declared diagnostics enter UI text. Never stringify submitted values or evidence. */
export function serviceErrorMessage(error: unknown, fallback = "Service request failed"): string {
  if (!(error instanceof ApiClientError)) return fallback;
  const validation = sdk.adminServiceValidationErrorSchema.safeParse(error.payload);
  if (validation.success)
    return (
      validation.data.errors
        .slice(0, 8)
        .map((s) => s.slice(0, 512))
        .join("; ") || fallback
    );
  return sdk.adminErrorMessage(error, fallback);
}
export async function serviceOrThrow<R extends { status: number; headers: Headers; data: unknown }>(
  pending: Promise<R>,
) {
  try {
    return sdk.unwrapAdminResponse(await pending);
  } catch (error) {
    throw new Error(serviceErrorMessage(error), { cause: error });
  }
}

/** Transport and wire validation stay in the generated SDK and canonical schemas. */
export function serviceAdminQueries(client: ApiClient, apiUrl: string) {
  const key = ["admin", "services", apiUrl] as const;
  const options = (signal: AbortSignal) => ({ client, signal, timeoutMs: SERVICE_READ_TIMEOUT_MS });
  return {
    list: () =>
      queryOptions({
        queryKey: [...key, "list"],
        queryFn: ({ signal }) => serviceOrThrow(sdk.listAdminServices(options(signal))),
      }),
    detail: (id: string) =>
      queryOptions({
        queryKey: [...key, "detail", id],
        queryFn: async ({ signal }) =>
          sdk.adminServiceDetailSchema.parse(
            await serviceOrThrow(sdk.getAdminService(id, options(signal))),
          ),
      }),
    config: (id: string) =>
      queryOptions({
        queryKey: [...key, "config", id],
        queryFn: ({ signal }) => serviceOrThrow(sdk.getAdminServiceConfig(id, options(signal))),
      }),
    credentials: (id: string) =>
      queryOptions({
        queryKey: [...key, "credentials", id],
        queryFn: ({ signal }) =>
          serviceOrThrow(sdk.getAdminServiceCredentials(id, options(signal))),
      }),
    selection: () =>
      queryOptions({
        queryKey: [...key, "selection"],
        queryFn: ({ signal }) => serviceOrThrow(sdk.getAdminServiceSelection(options(signal))),
      }),
    backups: () =>
      queryOptions({
        queryKey: [...key, "backups"],
        queryFn: ({ signal }) => serviceOrThrow(sdk.listAdminServiceBackups(options(signal))),
      }),
    data: () =>
      queryOptions({
        queryKey: [...key, "data"],
        queryFn: ({ signal }) => serviceOrThrow(sdk.getAdminServiceData(options(signal))),
      }),
    policy: () =>
      queryOptions({
        queryKey: [...key, "policy"],
        queryFn: ({ signal }) => serviceOrThrow(sdk.getAdminSharedMobility(options(signal))),
      }),
    operations: () =>
      queryOptions({
        queryKey: [...key, "operations"],
        queryFn: ({ signal }) => serviceOrThrow(sdk.listAdminOperations(options(signal))),
      }),
    compose: () =>
      queryOptions({
        queryKey: [...key, "compose"],
        queryFn: ({ signal }) => serviceOrThrow(sdk.getAdminComposePreview(options(signal))),
      }),
    deployment: () =>
      queryOptions({
        queryKey: [...key, "deployment"],
        queryFn: ({ signal }) => serviceOrThrow(sdk.getAdminDeployment(options(signal))),
      }),
    dawarich: () =>
      queryOptions({
        queryKey: [...key, "dawarich"],
        queryFn: ({ signal }) => serviceOrThrow(sdk.getAdminDawarich(options(signal))),
      }),
  };
}

export type ServiceAdministrationEffect = (
  | { kind: "service" | "configuration" | "credentials"; serviceId: string }
  | { kind: "catalog" | "backups" | "data" | "policy" | "operations" | "compose" | "dawarich" }
) & {
  /** Origin-scoped status queries owned by the invoking feature (e.g. data-manager reads). */ refreshKeys?: readonly QueryKey[];
};

/** Same graph for synchronous writes and all terminal outcomes of accepted jobs. */
export function invalidateServiceAdministration(
  queryClient: QueryClient,
  apiUrl: string,
  effect: ServiceAdministrationEffect,
): Promise<unknown[]> {
  const key = ["admin", "services", apiUrl];
  const resources: readonly unknown[][] =
    "serviceId" in effect
      ? [
          [...key, "list"],
          [...key, "detail", effect.serviceId],
          [...key, "config", effect.serviceId],
          [...key, "credentials", effect.serviceId],
          [...key, "compose"],
          [...key, "deployment"],
          [...key, "dawarich"],
        ]
      : [key];
  return Promise.all([
    ...(effect.refreshKeys ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    ...resources.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    queryClient.invalidateQueries({ queryKey: ["admin", "overview", apiUrl] }),
    invalidateIntegrationRuntime(queryClient, apiUrl),
  ]);
}
