"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

/**
 * The reader-facing name of a data-manager job stage such as `motis-import`.
 * `scripts/admin-code-catalogue.test.ts` keeps `adminShared.jobStages` in
 * step with the transit pipeline's stage names. A stage this build does not
 * know, such as one a newer server added, is shown as its code.
 */
export function useJobStageLabel(): (stage: string) => string {
  const t = useTranslations("adminShared.jobStages");
  return useCallback(
    (stage: string) => {
      const key = stage.replace(/[.:-]/g, "_");
      return t.has(key) ? t(key) : stage;
    },
    [t],
  );
}
