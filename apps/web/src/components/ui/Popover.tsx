"use client";

import MuiPopover, { type PopoverActions, type PopoverProps } from "@mui/material/Popover";
import { useBackDismiss } from "@/lib/useBackDismiss";

export type { PopoverActions, PopoverProps };

/** MUI's Popover, closed by the system Back gesture the way Escape closes it. See `./Dialog`. */
export default function Popover(props: PopoverProps) {
  const { open, onClose } = props;
  useBackDismiss(open && Boolean(onClose), () => onClose?.({}, "escapeKeyDown"));
  return <MuiPopover {...props} />;
}
