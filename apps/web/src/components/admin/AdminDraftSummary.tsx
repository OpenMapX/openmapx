"use client";
import Button from "@mui/material/Button";
import Tooltip from "@mui/material/Tooltip";
import { useTranslations } from "next-intl";
import { useAdminDraftCount, useAdminDraftExit } from "@/lib/admin/AdminDraftProvider";
export function AdminDraftSummary() {
  const count = useAdminDraftCount();
  const requestExit = useAdminDraftExit();
  const t = useTranslations("adminNavigation");
  if (!count) return null;
  return (
    <Tooltip title={t("discardDraftsHelp")}>
      <Button size="small" color="warning" onClick={() => void requestExit(t("discardDraftsHelp"))}>
        {t("drafts", { count })}
      </Button>
    </Tooltip>
  );
}
