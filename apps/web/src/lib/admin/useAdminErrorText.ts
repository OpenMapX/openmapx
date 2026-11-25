"use client";
import { ApiClientError } from "@openmapx/core";
import { requiredSettingsMissingSchema } from "@openmapx/core/api-contracts";
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { adminErrorText } from "./adminRequestError";

/** The required settings a refused configuration apply names, by service, or null. */
export function missingServiceSettings(
  error: unknown,
): { serviceId: string; keys: string[] }[] | null {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof ApiClientError) {
      const refusal = requiredSettingsMissingSchema.safeParse(cause.payload);
      return refusal.success ? refusal.data.missingSettings : null;
    }
  }
  return null;
}

/**
 * Words a failed admin request like `adminErrorText`, and names the services
 * and settings when an apply was refused for required settings without a
 * value, in the reader's language.
 */
export function useAdminErrorText(): (error: unknown, fallback: string) => string {
  const t = useTranslations("adminShared");
  return useCallback(
    (error: unknown, fallback: string) => {
      const missing = missingServiceSettings(error);
      if (!missing) return adminErrorText(error, fallback);
      return t("requiredSettingsMissing", {
        settings: missing
          .map(({ serviceId, keys }) => `${serviceId} (${keys.join(", ")})`)
          .join("; "),
      });
    },
    [t],
  );
}
