import { type ApiClient, ApiClientError } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import {
  matchQuery,
  type QueryClient,
  type QueryFilters,
  type QueryKey,
  queryOptions,
} from "@tanstack/react-query";
import { integrationRuntimeQueryKey } from "@/lib/integrationRuntimeQuery";

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
    data: (page: { osmLimit?: number; osmOffset?: number } = {}) =>
      queryOptions({
        queryKey: [...key, "data", String(page.osmLimit ?? 50), String(page.osmOffset ?? 0)],
        queryFn: ({ signal }) => serviceOrThrow(sdk.getAdminServiceData(page, options(signal))),
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
        queryFn: ({ signal }) =>
          serviceOrThrow(sdk.getAdminDawarich({ ...options(signal), cache: "no-store" })),
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
export async function invalidateServiceAdministration(
  queryClient: QueryClient,
  apiUrl: string,
  effect: ServiceAdministrationEffect,
): Promise<void> {
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
  const queryKeys = [
    ...(effect.refreshKeys ?? []),
    ...resources,
    ["admin", "overview", apiUrl],
    integrationRuntimeQueryKey(apiUrl),
  ];
  const filters: QueryFilters = {
    predicate: (query) => queryKeys.some((queryKey) => matchQuery({ queryKey }, query)),
  };
  // Invalidation alone can join a pre-effect initial fetch when it has no data.
  // Cancel all matching reads before starting any replacements. One union avoids
  // overlapping prefixes canceling/refetching a replacement more than once.
  await queryClient.cancelQueries(filters);
  // Default active-only refetch preserves invalidation for inactive queries too.
  await queryClient.invalidateQueries(filters);
}

/** Display the same decision used by the server, without inferring permission from status. */
export function serviceActionReason(
  decision: import("@openmapx/core/ops").ServiceActionDecision | undefined,
): string | null {
  if (decision?.available) return null;
  switch (decision?.reason) {
    case "disabled":
      return "Enable this service before using this action.";
    case "not_owned":
      return "No owned container is available for this action.";
    case "not_running":
      return "This service is not running.";
    case "control_plane":
      return "Use System Maintenance for core updates; stopping the control plane requires host access.";
    case "host_only":
      return "This action requires host access.";
    case "not_buildable":
      return "This service does not prepare build artifacts.";
    default:
      return "This action is currently unavailable. Check the operations agent.";
  }
}
