"use client";

import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import type { MouseEvent, ReactNode } from "react";
import { BRAND } from "@/integration-api/runtime/theme";

interface LayerPreviewTileProps {
  preview: ReactNode;
  label: string;
  /** Whether the layer is on. Left out for a tile that is an action, not a toggle. */
  selected?: boolean;
  /** Accessible name when it should say more than the visible label. */
  ariaLabel?: string;
  size?: number;
  labelWidth?: number;
  disabled?: boolean;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  children?: ReactNode;
}

export function LayerPreviewTile({
  preview,
  label,
  selected,
  ariaLabel,
  size = 48,
  labelWidth,
  disabled = false,
  onClick,
  children,
}: LayerPreviewTileProps) {
  const content = (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        opacity: disabled ? 0.42 : 1,
        filter: disabled ? "grayscale(1)" : "none",
      }}
    >
      <Box
        sx={{
          width: size,
          height: size,
          borderRadius: `${Math.round(size * 0.22)}px`,
          overflow: "hidden",
          border: selected ? `2px solid ${BRAND}` : "1px solid var(--omx-border-light)",
          "& > svg, & > img": {
            display: "block",
            width: "100%",
            height: "100%",
          },
          "& > img": { objectFit: "cover" },
        }}
      >
        {preview}
      </Box>
      <Typography
        sx={{
          mt: 0.5,
          width: labelWidth,
          fontSize: size >= 48 ? 12 : 11,
          lineHeight: 1.25,
          fontWeight: selected ? 600 : 500,
          color: selected ? BRAND : "text.secondary",
          // A fixed label width wraps long names; otherwise the label stays on one line.
          whiteSpace: labelWidth ? "pre-line" : "nowrap",
          textAlign: "center",
        }}
      >
        {label}
      </Typography>
      {children}
    </Box>
  );

  if (!onClick) return content;

  return (
    <ButtonBase
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={ariaLabel}
      sx={{
        // Tiles in a row line up by their previews, whatever their label length.
        alignItems: "flex-start",
        borderRadius: `${Math.round(size * 0.22)}px`,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {content}
    </ButtonBase>
  );
}
