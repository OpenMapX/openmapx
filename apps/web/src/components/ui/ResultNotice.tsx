"use client";

import ErrorOutlinedIcon from "@mui/icons-material/ErrorOutlined";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import ZoomInIcon from "@mui/icons-material/ZoomIn";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

/** A notice above a result list: an error, or a note that the results are incomplete. */
export function ResultNotice({
  tone,
  children,
  action,
  pending = false,
}: {
  tone: "error" | "info";
  children: ReactNode;
  action?: { label: string; kind: "retry" | "zoom"; onClick: () => void };
  pending?: boolean;
}) {
  const Icon = tone === "error" ? ErrorOutlinedIcon : InfoOutlinedIcon;
  const ActionIcon = action?.kind === "zoom" ? ZoomInIcon : RefreshIcon;

  return (
    <Box
      role={tone === "error" ? "alert" : "status"}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        minHeight: 48,
        minWidth: 0,
        px: 1.5,
        py: 0.5,
        borderRadius: "24px",
        bgcolor: `color-mix(in srgb, var(--mui-palette-${tone}-main) 11%, var(--mui-palette-background-paper))`,
      }}
    >
      {pending ? (
        <CircularProgress size={19} color="info" aria-hidden="true" sx={{ flexShrink: 0 }} />
      ) : (
        <Icon aria-hidden="true" sx={{ fontSize: 19, color: `${tone}.main`, flexShrink: 0 }} />
      )}
      <Typography variant="body2" sx={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>
        {children}
      </Typography>
      {action && (
        <Tooltip title={action.label}>
          <IconButton
            color={tone}
            aria-label={action.label}
            onClick={action.onClick}
            sx={{
              flex: "0 0 44px",
              width: 44,
              height: 44,
              "&.Mui-focusVisible": {
                outline: "2px solid",
                outlineColor: `${tone}.main`,
                outlineOffset: 2,
              },
            }}
          >
            <ActionIcon aria-hidden="true" fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}
