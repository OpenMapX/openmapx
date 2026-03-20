"use client";

import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import type { DesktopMoreOption } from "./layerSelectorConfig";

export function DesktopMoreTile({
  item,
  label,
  labelWidth = 132,
  onClick,
}: {
  item: DesktopMoreOption;
  label: string;
  labelWidth?: number;
  onClick?: () => void;
}) {
  const inner = (
    <Box
      sx={{
        minHeight: 76,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <Box
        sx={{
          width: 48,
          height: 48,
          borderRadius: "14px",
          overflow: "hidden",
          border: item.selected ? "2px solid #0b7d8b" : "1px solid rgba(60,64,67,0.1)",
          boxShadow: item.selected
            ? "0 0 0 1px rgba(11,125,139,0.22)"
            : "0 1px 3px rgba(0,0,0,0.06)",
        }}
      >
        {item.preview}
      </Box>
      <Typography
        sx={{
          mt: 0.58,
          fontSize: 12.5,
          color: item.selected ? "#0b7d8b" : "#3c4043",
          lineHeight: 1.2,
          whiteSpace: "pre-line",
          width: labelWidth,
          textAlign: "center",
        }}
      >
        {label}
      </Typography>
    </Box>
  );

  if (onClick) {
    return (
      <ButtonBase onClick={onClick} sx={{ borderRadius: "14px" }}>
        {inner}
      </ButtonBase>
    );
  }

  return inner;
}
