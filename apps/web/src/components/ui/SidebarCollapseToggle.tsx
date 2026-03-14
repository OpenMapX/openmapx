"use client";

import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import { PANEL_WIDTH } from "@/lib/layout";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
}

/** Desktop-only collapse/expand toggle tab anchored to the right edge of the sidebar. */
export function SidebarCollapseToggle({ collapsed, onToggle }: Props) {
  return (
    <Tooltip title={collapsed ? "Show sidebar" : "Hide sidebar"} placement="right">
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
          zIndex: 9,
          bgcolor: "background.paper",
          borderRadius: "0 6px 6px 0",
          boxShadow: "2px 2px 8px rgba(0,0,0,0.15)",
          width: 20,
          height: 48,
          padding: 0,
          "&:hover": { bgcolor: "grey.50" },
        }}
        aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
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
