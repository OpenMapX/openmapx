"use client";

import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import { useTranslations } from "next-intl";
import { PANEL_WIDTH } from "@/lib/layout";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  zIndex?: number;
}

/** Desktop-only collapse/expand toggle tab anchored to the right edge of the sidebar. */
export function SidebarCollapseToggle({ collapsed, onToggle, zIndex = 9 }: Props) {
  const t = useTranslations("sidebar");
  return (
    <Tooltip title={collapsed ? t("showSidebar") : t("hideSidebar")} placement="right">
      <IconButton
        onClick={onToggle}
        size="small"
        sx={{
          display: { xs: "none", sm: "flex" },
          alignItems: "center",
          justifyContent: "center",
          position: "absolute",
          top: "50%",
          left: collapsed ? 0 : PANEL_WIDTH,
          transform: "translateY(-50%)",
          transition: "left 0.25s ease",
          zIndex,
          bgcolor: "background.paper",
          borderRadius: "0 6px 6px 0",
          boxShadow: "2px 2px 8px var(--omx-shadow-soft)",
          width: 20,
          height: 48,
          padding: 0,
          "&:hover": { filter: "brightness(0.92)" },
        }}
        aria-label={collapsed ? t("showSidebar") : t("hideSidebar")}
      >
        {collapsed ? (
          <ChevronRightIcon sx={{ fontSize: 16 }} />
        ) : (
          <ChevronLeftIcon sx={{ fontSize: 16 }} />
        )}
      </IconButton>
    </Tooltip>
  );
}
