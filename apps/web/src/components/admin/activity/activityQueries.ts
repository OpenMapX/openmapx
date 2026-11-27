"use client";

import { type ApiClient, createApiClient } from "@openmapx/core";
import {
  getAdminActivityJob,
  listAdminIntegrations,
  unwrapAdminResponse,
} from "@openmapx/core/api-admin-sdk";
import {
  type AdminActivityJob,
  type AdminActivityJobDetail,
  type AdminActivityJobSource,
  adminJobObservationSchema,
} from "@openmapx/core/api-contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { browserAdminApiBase } from "@/lib/admin/browserAdminApiBase";
import { useJobTypeLabel } from "../shared/jobTypeLabel";

/** JSON reads are finite; this deadline never owns a native EventSource. */
export const ACTIVITY_READ_TIMEOUT_MS = 30_000;

export function useActivityClient() {
  const { apiUrl } = useEnv();
  const client = useMemo(
    () => createApiClient({ baseUrl: browserAdminApiBase(apiUrl), credentials: "include" }),
    [apiUrl],
  );
  return { apiUrl, client };
}

export function activityJobQueryOptions(
  client: ApiClient,
  apiUrl: string,
  id: string | undefined,
  source: AdminActivityJobSource,
) {
  return queryOptions({
    queryKey: ["admin", "jobs", "detail", apiUrl, source, id],
    enabled: Boolean(id),
    queryFn: async ({ signal }): Promise<AdminActivityJobDetail> => {
      if (!id) throw new Error("No job selected");
      const job = unwrapAdminResponse(
        await getAdminActivityJob(
          id,
          { source },
          { client, signal, timeoutMs: ACTIVITY_READ_TIMEOUT_MS },
        ),
      );
      if (job.id !== id || job.source !== source)
        throw new Error("Admin job response did not match the requested identity");
      return job;
    },
  });
}

type LabelledJob = Pick<AdminActivityJob, "source" | "type">;

/**
 * The reader-facing name of each listed job. A scheduled task's run, whose
 * type is `<integrationId>:<taskName>`, is named after its integration, and by
 * its type once that integration is no longer installed. The integrations are
 * read only while such a run is listed, under the integration list's own
 * query key, so the two views share one request.
 */
export function useActivityJobLabel(
  jobs: readonly LabelledJob[] | undefined,
): (job: LabelledJob) => string {
  const t = useTranslations("adminActivity");
  const jobTypeLabel = useJobTypeLabel();
  const { apiUrl, client } = useActivityClient();
  const listsTaskRuns = jobs?.some((job) => job.source === "integration-task") ?? false;
  const { data: integrations } = useQuery({
    queryKey: ["admin", "integrations", apiUrl, "list"],
    queryFn: async ({ signal }) =>
      unwrapAdminResponse(
        await listAdminIntegrations({ client, signal, timeoutMs: ACTIVITY_READ_TIMEOUT_MS }),
      ),
    enabled: listsTaskRuns,
  });
  return useCallback(
    (job: LabelledJob) => {
      if (job.source !== "integration-task") return jobTypeLabel(job.type);
      const separator = job.type.indexOf(":");
      const integrationId = job.type.slice(0, separator);
      const integration = integrations?.find((candidate) => candidate.id === integrationId);
      return separator > 0 && integration
        ? t("integrationTaskLabel", {
            integration: integration.name,
            task: job.type.slice(separator + 1),
          })
        : job.type;
    },
    [integrations, jobTypeLabel, t],
  );
}

export function hasUnresolvedJobObservation(result: unknown): boolean {
  return (
    !!result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    adminJobObservationSchema.safeParse((result as Record<string, unknown>).observation).success
  );
}
