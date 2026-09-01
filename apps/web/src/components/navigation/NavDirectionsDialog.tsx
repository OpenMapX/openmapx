"use client";

import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import type { Route } from "@openmapx/core";
import { DetailsView } from "@/components/panels/directions/DetailsView";
import {
  mobileFullScreenDialogPaperSx,
  useFullScreenOnMobile,
} from "@/integration-api/runtime/useFullScreenOnMobile";

/**
 * The full turn-by-turn step list during navigation, in a dialog. Reuses the
 * directions panel's {@link DetailsView} (its back button closes the dialog), so
 * the list stays identical to the one shown before the trip starts.
 */
export function NavDirectionsDialog({
  open,
  onClose,
  route,
  units,
}: {
  open: boolean;
  onClose: () => void;
  route: Route;
  units: "metric" | "imperial";
}) {
  const fullScreen = useFullScreenOnMobile();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      fullScreen={fullScreen}
      slotProps={{ paper: { sx: mobileFullScreenDialogPaperSx } }}
    >
      <DialogContent sx={{ p: 0 }}>
        <DetailsView
          route={route}
          originLabel=""
          destinationLabel=""
          units={units}
          onBack={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
