"use client";

import CloseIcon from "@mui/icons-material/Close";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Popover from "@mui/material/Popover";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";

/** Optional traffic explanation; never nested inside route selection controls. */
export function TrafficInfo({ children }: { children: ReactNode }) {
  const t = useTranslations("trafficStatus");
  const tc = useTranslations("common");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const id = useId();
  return (
    <>
      <IconButton
        size="small"
        sx={{ minWidth: 44, minHeight: 44 }}
        aria-label={t("about")}
        aria-haspopup="dialog"
        aria-expanded={Boolean(anchor)}
        aria-controls={anchor ? id : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setAnchor(event.currentTarget);
        }}
      >
        <InfoOutlinedIcon sx={{ fontSize: 18 }} />
      </IconButton>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        onClick={(event) => event.stopPropagation()}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{
          paper: {
            id,
            role: "dialog",
            "aria-label": t("about"),
            sx: { p: 2, width: 300, maxWidth: "calc(100vw - 32px)", overflowWrap: "anywhere" },
          },
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
          <Typography variant="subtitle2">{t("about")}</Typography>
          <IconButton size="small" aria-label={tc("close")} onClick={() => setAnchor(null)}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
        {children}
      </Popover>
    </>
  );
}
