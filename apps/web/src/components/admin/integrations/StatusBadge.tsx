"use client";

import BuildIcon from "@mui/icons-material/Build";
import GroupsIcon from "@mui/icons-material/Groups";
import VerifiedIcon from "@mui/icons-material/Verified";
import type { ChipProps } from "@mui/material/Chip";
import Chip from "@mui/material/Chip";

type Quality = "built-in" | "community-verified" | "community";

const QUALITY_CONFIG: Record<
  Quality,
  { label: string; color: ChipProps["color"]; icon: React.ReactElement }
> = {
  "built-in": {
    label: "Built-in",
    color: "primary",
    icon: <BuildIcon sx={{ fontSize: "0.85rem !important" }} />,
  },
  "community-verified": {
    label: "Verified",
    color: "success",
    icon: <VerifiedIcon sx={{ fontSize: "0.85rem !important" }} />,
  },
  community: {
    label: "Community",
    color: "default",
    icon: <GroupsIcon sx={{ fontSize: "0.85rem !important" }} />,
  },
};

interface StatusBadgeProps {
  quality: Quality;
  size?: "small" | "medium";
}

export function StatusBadge({ quality, size = "small" }: StatusBadgeProps) {
  const config = QUALITY_CONFIG[quality] ?? QUALITY_CONFIG["built-in"];

  return (
    <Chip
      label={config.label}
      color={config.color}
      icon={config.icon}
      size={size}
      variant="filled"
      sx={{ fontWeight: 600, fontSize: "0.7rem" }}
    />
  );
}
