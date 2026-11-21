"use client";

import { useTranslations } from "next-intl";

/**
 * The reader-facing name of where a configuration value or credential comes
 * from (`default`, `database`, `vault`, `config.json`, `env`, `missing`).
 */
export function useConfigSourceLabel(): (source: string) => string {
  const t = useTranslations("adminShared");
  return (source) => t("configSource", { source: source.replace(".", "_") });
}
