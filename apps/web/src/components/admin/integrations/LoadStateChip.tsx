"use client";

import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import type { AdminIntegrationSummary } from "@openmapx/core/api-contracts";
import { useTranslations } from "next-intl";

/**
 * Why the host does not run an integration, as a chip beside its name: its
 * code failed, this release cannot run it, safe mode holds it back, or its
 * extension is disabled. Nothing for an integration the host loaded.
 */
export function LoadStateChip({
  integration,
}: {
  integration: Pick<AdminIntegrationSummary, "status" | "loadState" | "loadError">;
}) {
  const t = useTranslations("adminIntegrations");
  const chip = (() => {
    if (integration.status === "failed")
      return {
        label: t("failedToLoad"),
        detail: integration.loadError
          ? t("failedToLoadDetail", { error: integration.loadError })
          : t("loadFailedTitle"),
        color: "error" as const,
      };
    if (integration.status === "incompatible")
      return {
        label: t("incompatibleChip"),
        detail: t("incompatibleChipDetail", { error: integration.loadError ?? "" }),
        color: "warning" as const,
      };
    if (integration.status === "safe-mode")
      return { label: t("safeModeChip"), detail: t("safeModeChipDetail"), color: "info" as const };
    if (integration.loadState === "disabled")
      return {
        label: t("extensionDisabledChip"),
        detail: t("extensionDisabledChipDetail"),
        color: "default" as const,
      };
    return null;
  })();
  if (!chip) return null;
  return (
    <Tooltip title={chip.detail}>
      <Chip
        label={chip.label}
        size="small"
        color={chip.color}
        variant="outlined"
        sx={{ alignSelf: "flex-start" }}
      />
    </Tooltip>
  );
}
