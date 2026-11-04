"use client";

import MuiDialog, { type DialogProps } from "@mui/material/Dialog";
import { useBackDismiss } from "@/lib/useBackDismiss";

export type { DialogProps };

/**
 * MUI's Dialog, closed by the system Back gesture the way Escape closes it.
 * Use it instead of `@mui/material/Dialog` (lint enforces this): on a phone,
 * Back is how people dismiss a dialog, and without it Back leaves the app.
 */
export default function Dialog(props: DialogProps) {
  const { open, onClose } = props;
  useBackDismiss(open && Boolean(onClose), () => onClose?.({}, "escapeKeyDown"));
  return <MuiDialog {...props} />;
}
