"use client";

import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Switch from "@mui/material/Switch";
import type { ReactNode } from "react";
import {
  useOverlayLayerVisible,
  useOverlaySetLayerVisible,
} from "@/components/map/overlay/useOverlayStoreState";

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
    <ListItemButton onClick={onClick}>
      <ListItemIcon sx={{ minWidth: 44 }}>{icon}</ListItemIcon>
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
    <ListItemButton onClick={() => onToggle(!checked)}>
      <ListItemIcon sx={{ minWidth: 44 }}>{icon}</ListItemIcon>
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
