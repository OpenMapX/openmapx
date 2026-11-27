"use client";

import type { AdminActivityJob } from "@openmapx/core/api-contracts";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { integrationAdminQueries } from "@/lib/admin/integrationAdmin";
import { useJobTypeLabel } from "../shared/jobTypeLabel";
import { useActivityClient } from "./activityQueries";

type LabelledJob = Pick<AdminActivityJob, "source" | "type">;

/**
 * The reader-facing name of each listed job. A scheduled task's run, whose
 * type is `<integrationId>:<taskName>`, is named after its integration, and by
 * its type once that integration is no longer installed. The integrations are
 * read only while such a run is listed, with the integration list's own
 * query, so the two views share one request.
 */
export function useActivityJobLabel(
  jobs: readonly LabelledJob[] | undefined,
): (job: LabelledJob) => string {
  const t = useTranslations("adminActivity");
  const jobTypeLabel = useJobTypeLabel();
  const { apiUrl, client } = useActivityClient();
  const listsTaskRuns = jobs?.some((job) => job.source === "integration-task") ?? false;
  const { data: integrations } = useQuery({
    ...integrationAdminQueries(client, apiUrl).list(),
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
