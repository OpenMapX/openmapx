"use client";

import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";
import { TEAL } from "@/lib/theme";

interface LayerPreviewTileProps {
  preview: ReactNode;
  label: string;
  selected?: boolean;
  icon?: ReactNode;
  size?: number;
  labelWidth?: number;
  disabled?: boolean;
  onClick?: () => void;
  children?: ReactNode;
}

export function LayerPreviewTile({
  preview,
  label,
  selected = false,
  icon,
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
          border: selected ? `2px solid ${TEAL}` : "1px solid rgba(60,64,67,0.1)",
          boxShadow: selected ? "0 0 0 1px rgba(11,125,139,0.22)" : "0 1px 3px rgba(0,0,0,0.06)",
          "& > svg": {
            display: "block",
            width: "100%",
            height: "100%",
          },
        }}
      >
        {preview}
      </Box>
      <Box
        sx={{
          mt: 0.4,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 0.3,
          width: labelWidth,
        }}
      >
        {icon ? (
          <Box sx={{ display: "flex", color: selected ? TEAL : "text.secondary" }}>{icon}</Box>
        ) : null}
        <Typography
          sx={{
            fontSize: size >= 48 ? 12 : 11,
            lineHeight: 1.2,
            fontWeight: selected ? 600 : 500,
            color: selected ? TEAL : "text.secondary",
            whiteSpace: "pre-line",
            textAlign: "center",
          }}
        >
          {label}
        </Typography>
      </Box>
      {children}
    </Box>
  );

  if (!onClick) return content;

  return (
    <ButtonBase
      onClick={onClick}
      disabled={disabled}
      sx={{
        borderRadius: `${Math.round(size * 0.22)}px`,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {content}
    </ButtonBase>
  );
}
