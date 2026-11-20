"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

/**
 * The reader-facing name of an audit action code such as `service.restart`.
 * The server records free-form codes; one the catalogue does not know, such
 * as an operation added after this build, is shown as its code.
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
