"use client";

import MuiMenu, { type MenuProps } from "@mui/material/Menu";
import { useBackDismiss } from "@/lib/useBackDismiss";

export type { MenuProps };

/** MUI's Menu, closed by the system Back gesture the way Escape closes it. See `./Dialog`. */
export default function Menu(props: MenuProps) {
  const { open, onClose } = props;
  useBackDismiss(open && Boolean(onClose), () => onClose?.({}, "escapeKeyDown"));
  return <MuiMenu {...props} />;
}
