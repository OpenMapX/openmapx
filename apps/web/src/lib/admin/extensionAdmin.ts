import { type ApiClient, isApiRequestAbortedError } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import {
  type AdminExtensionCatalogQuery,
  adminExtensionCatalogDetailSchema,
  adminExtensionCatalogSchema,
} from "@openmapx/core/api-contracts";
import {
  matchQuery,
  type QueryClient,
  type QueryFilters,
  queryOptions,
} from "@tanstack/react-query";
import { integrationRuntimeQueryKey } from "@/lib/integrationRuntimeQuery";

export const EXTENSION_READ_TIMEOUT_MS = 30_000;
export const EXTENSION_RESOLUTION_TIMEOUT_MS = 180_000;
export interface ExtensionAdministrationClient {
  client: ApiClient;
  apiUrl: string;
}

export async function extensionOrThrow<
  R extends { status: number; data: unknown; headers: Headers },
>(pending: Promise<R>) {
  try {
    return sdk.unwrapAdminResponse(await pending);
  } catch (error) {
    const fallback = isApiRequestAbortedError(error)
      ? "Extension request ended without a confirmed result. Work may still be running; this does not cancel a host job. Check Activity before deliberately retrying."
      : "Extension request failed";
    throw new Error(sdk.adminErrorMessage(error, fallback), { cause: error });
  }
}

export function extensionAdminQueries(client: ApiClient, apiUrl: string) {
  const key = ["admin", "extensions", apiUrl] as const;
  const options = (signal: AbortSignal) => ({
    client,
    signal,
    timeoutMs: EXTENSION_READ_TIMEOUT_MS,
  });
  return {
    catalog: (filters: AdminExtensionCatalogQuery = {}) =>
      queryOptions({
        queryKey: [...key, "catalog", filters],
        queryFn: async ({ signal }) =>
          adminExtensionCatalogSchema.parse(
            await extensionOrThrow(sdk.listAdminExtensionCatalog(filters, options(signal))),
          ),
      }),
    detail: (id: string) =>
      queryOptions({
        queryKey: [...key, "detail", id],
        queryFn: async ({ signal }) =>
          adminExtensionCatalogDetailSchema.parse(
            await extensionOrThrow(sdk.getAdminExtensionCatalogEntry(id, options(signal))),
          ),
      }),
    installed: () =>
      queryOptions({
        queryKey: [...key, "installed"],
        queryFn: ({ signal }) =>
          extensionOrThrow(sdk.listAdminInstalledExtensions(options(signal))),
      }),
    sources: () =>
      queryOptions({
        queryKey: [...key, "sources"],
        queryFn: ({ signal }) => extensionOrThrow(sdk.listAdminExtensionSources(options(signal))),
      }),
  };
}

/** Snapshot writes refresh installed badges too; terminal jobs may change components/config. */
export async function invalidateExtensionAdministration(
  qc: QueryClient,
  apiUrl: string,
  effect: "snapshot" | "components",
) {
  const keys: readonly (readonly string[])[] = [
    ["admin", "extensions", apiUrl],
    ...(effect === "components"
      ? [
          ["admin", "services", apiUrl],
          ["admin", "integrations", apiUrl],
          ["admin", "credentials", apiUrl],
          ["admin", "overview", apiUrl],
          integrationRuntimeQueryKey(apiUrl),
        ]
      : []),
  ];
  const filters: QueryFilters = {
    predicate: (query) => keys.some((queryKey) => matchQuery({ queryKey }, query)),
  };
  await qc.cancelQueries(filters);
  await qc.invalidateQueries(filters);
}
