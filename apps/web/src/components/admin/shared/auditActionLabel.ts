"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

/**
 * The reader-facing name of an audit action code such as `service.restart`.
 * `scripts/admin-code-catalogue.test.ts` keeps `adminShared.auditActions` in
 * step with the API's audit writers; an action this build does not know,
 * such as one a newer server records, is shown as its code.
 */
export function useAuditActionLabel(): (action: string) => string {
  const t = useTranslations("adminShared.auditActions");
  return useCallback(
    (action: string) => {
      const key = action.replace(/[.-]/g, "_");
      return t.has(key) ? t(key) : action;
    },
    [t],
  );
}
