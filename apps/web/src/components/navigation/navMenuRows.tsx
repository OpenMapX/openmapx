"use client";

import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Switch from "@mui/material/Switch";
import type { ReactNode } from "react";
import {
  useOverlayLayerVisible,
  useOverlaySetLayerVisible,
} from "@/integration-api/overlay/useOverlayStoreState";

/** Quiet leading icons, so the labels carry the rows. */
const ICON_SX = { minWidth: 48, color: "text.secondary" } as const;
/** Rows tall enough to hit while driving. */
const ROW_SX = { minHeight: 56 } as const;

/** An action row: leading icon, label, tap runs `onClick`. */
export function ActionRow({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <ListItemButton onClick={onClick} sx={ROW_SX}>
      <ListItemIcon sx={ICON_SX}>{icon}</ListItemIcon>
      <ListItemText primary={label} />
    </ListItemButton>
  );
}

/** A toggle row: leading icon, label, trailing Switch reflecting `checked`. */
export function ToggleRow({
  icon,
  label,
  checked,
  onToggle,
}: {
  icon: ReactNode;
  label: string;
  checked: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <ListItemButton onClick={() => onToggle(!checked)} sx={ROW_SX}>
      <ListItemIcon sx={ICON_SX}>{icon}</ListItemIcon>
      <ListItemText primary={label} />
      <Switch edge="end" checked={checked} tabIndex={-1} disableRipple />
    </ListItemButton>
  );
}

/**
 * An overlay toggle bound to a registered overlay store by id. Render only when
 * the overlay is available, since its hooks resolve/create the store.
 */
export function OverlayToggleRow({
  overlayId,
  icon,
  label,
}: {
  overlayId: string;
  icon: ReactNode;
  label: string;
}) {
  const visible = useOverlayLayerVisible(overlayId);
  const setVisible = useOverlaySetLayerVisible(overlayId);
  return <ToggleRow icon={icon} label={label} checked={visible} onToggle={setVisible} />;
}
