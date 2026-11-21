"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

/**
 * The reader-facing name of a job type code: an application job type such as
 * `service.restart` or a data-manager kind such as `transit-sync`.
 * `scripts/admin-code-catalogue.test.ts` keeps `adminShared.jobTypes` in step
 * with the code that creates jobs. A type this build does not know, such as
 * one a newer server added, is shown as its code with readable separators
 * (`search-index.build` → `search index › build`).
 */
export function useJobTypeLabel(): (type: string) => string {
  const t = useTranslations("adminShared.jobTypes");
  return useCallback(
    (type: string) => {
      const key = type.replace(/[.:-]/g, "_");
      return t.has(key) ? t(key) : type.replace(/[.:]/g, " › ").replace(/[_-]/g, " ");
    },
    [t],
  );
}
