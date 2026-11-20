"use client";
import { useTranslations } from "next-intl";
import { useCallback } from "react";

/**
 * The reader's-language label and description of a server-provided setting.
 * The server sends English; a setting the catalogue does not know, such as one
 * added after this build, keeps it.
 */
export function useSettingText() {
  const t = useTranslations("adminSettings");
  return useCallback(
    (setting: { key: string; label: string; description?: string }) => ({
      label: t.has(`settings.${setting.key}.label`)
        ? t(`settings.${setting.key}.label`)
        : setting.label,
      description: t.has(`settings.${setting.key}.description`)
        ? t(`settings.${setting.key}.description`)
        : setting.description,
    }),
    [t],
  );
}
