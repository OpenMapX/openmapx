"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

/**
 * The reader-facing name of a job type code such as `service.restart`. Job
 * types come from several systems and are open-ended; one the catalogue does
 * not know, such as a type added after this build, is shown as its code with
 * readable separators (`search-index.build` → `search index › build`).
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
