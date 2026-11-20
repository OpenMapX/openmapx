"use client";

import CloseIcon from "@mui/icons-material/Close";
import MenuIcon from "@mui/icons-material/Menu";
import ShareIcon from "@mui/icons-material/Share";
import TuneIcon from "@mui/icons-material/Tune";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMenuStore, useSession, useSidebarStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ShareRouteDialog } from "@/components/panels/directions/ShareRouteDialog";
import Menu from "@/components/ui/Menu";
import { shareCurrentUrl } from "@/lib/deepLink";

interface DirectionsPanelHeaderProps {
  /** Route options and sharing describe driving the route yourself. */
  showRouteControls: boolean;
  canShare: boolean;
  optionsOpen: boolean;
  onToggleOptions: () => void;
  onNotify: (message: string) => void;
}

/** The title row: menu, route options, sharing and close. */
export function DirectionsPanelHeader({
  showRouteControls,
  canShare,
  optionsOpen,
  onToggleOptions,
  onNotify,
}: DirectionsPanelHeaderProps) {
  const t = useTranslations("directions");
  const tp = useTranslations("place");
  const tShare = useTranslations("share");
  const [shareMenuAnchor, setShareMenuAnchor] = useState<HTMLElement | null>(null);
  const [shareRouteDialogOpen, setShareRouteDialogOpen] = useState(false);
  const { data: session } = useSession();

  const handleCopyCurrentView = async () => {
    setShareMenuAnchor(null);
    const result = await shareCurrentUrl();
    if (result === "copied") onNotify(tp("linkCopied"));
  };

  const handleShare = (event: React.MouseEvent<HTMLElement>) => {
    if (!session?.user?.id) {
      void handleCopyCurrentView();
      return;
    }
    setShareMenuAnchor(event.currentTarget);
  };

  return (
    <>
      {/* Keep panel actions separate so every travel mode gets the full panel width. */}
      <Box sx={{ display: "flex", alignItems: "center", px: 1, pt: 0.5 }}>
        <IconButton
          size="small"
          aria-label={t("menu")}
          onClick={() => useMenuStore.getState().open()}
          sx={{ width: 44, height: 44, flexShrink: 0 }}
        >
          <MenuIcon sx={{ fontSize: 22 }} />
        </IconButton>
        <Typography variant="subtitle2" sx={{ ml: 1, flex: 1, fontWeight: 600 }}>
          {t("routes")}
        </Typography>
        {/* Route options and sharing live in the title row, not rows of their own. */}
        {showRouteControls && (
          <Tooltip title={t("options")}>
            <IconButton
              size="small"
              aria-label={t("options")}
              aria-expanded={optionsOpen}
              onClick={onToggleOptions}
              sx={{
                width: 44,
                height: 44,
                flexShrink: 0,
                color: optionsOpen ? "primary.main" : undefined,
              }}
            >
              <TuneIcon sx={{ fontSize: 22 }} />
            </IconButton>
          </Tooltip>
        )}
        {showRouteControls && canShare && (
          <Tooltip title={tp("share")}>
            <IconButton
              size="small"
              aria-label={tp("share")}
              onClick={handleShare}
              sx={{ width: 44, height: 44, flexShrink: 0 }}
            >
              <ShareIcon sx={{ fontSize: 22 }} />
            </IconButton>
          </Tooltip>
        )}
        <IconButton
          size="small"
          onClick={() => useSidebarStore.getState().closeSidebar()}
          sx={{ width: 44, height: 44, flexShrink: 0 }}
          aria-label={t("close")}
        >
          <CloseIcon sx={{ fontSize: 22 }} />
        </IconButton>
      </Box>
      <Menu
        anchorEl={shareMenuAnchor}
        open={Boolean(shareMenuAnchor)}
        onClose={() => setShareMenuAnchor(null)}
      >
        <MenuItem onClick={() => void handleCopyCurrentView()}>
          {tShare("copyCurrentView")}
        </MenuItem>
        <MenuItem
          onClick={() => {
            setShareMenuAnchor(null);
            setShareRouteDialogOpen(true);
          }}
        >
          {tShare("createShareLink")}
        </MenuItem>
      </Menu>
      <ShareRouteDialog
        open={shareRouteDialogOpen}
        onClose={() => setShareRouteDialogOpen(false)}
      />
    </>
  );
}
