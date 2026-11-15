"use client";

import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { LAYER_SELECTOR_OPEN_EVENT } from "@/components/command-palette/constants";
import { CHIP_ROW_END } from "@/components/search/floatingChipSx";
import { SEARCH_BAR_INSET, topInset } from "@/lib/layout";
import { useMapObstructionInsets } from "@/lib/mapObstructions";
import { useBackDismiss } from "@/lib/useBackDismiss";
import { LayerDetailsPanel } from "./LayerDetailsPanel";

const SHEET_ID = "map-layer-sheet";

/**
 * The phone's layer control: a round button at the top right, under the chip
 * row and clear of every bottom sheet, opening map type, details and tools in
 * a bottom sheet.
 */
export function PhoneLayerSelector({ hidden }: { hidden: boolean }) {
  const t = useTranslations("layers");
  const [open, setOpen] = useState(false);
  // Under the chips, or under whatever else covers the top of the map (the
  // trip's stop card while planning directions).
  const coveredTop = useMapObstructionInsets().top;
  const close = () => setOpen(false);
  useBackDismiss(open, close);

  // The command palette and the footer's "manage overlays" link open it too.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(LAYER_SELECTOR_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(LAYER_SELECTOR_OPEN_EVENT, onOpen);
  }, []);

  return (
    <>
      {!hidden && (
        <Paper
          elevation={2}
          sx={{
            position: "absolute",
            top: `max(${topInset(SEARCH_BAR_INSET, CHIP_ROW_END.xs + 12)}, ${coveredTop + 12}px)`,
            right: "calc(12px + var(--omx-safe-right))",
            zIndex: 10,
            borderRadius: "50%",
          }}
        >
          <IconButton
            onClick={() => setOpen(true)}
            aria-label={t("openLayerMenu")}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? SHEET_ID : undefined}
            sx={{ width: 40, height: 40, borderRadius: "50%", color: "text.primary" }}
          >
            <LayersOutlinedIcon sx={{ fontSize: 22 }} />
          </IconButton>
        </Paper>
      )}
      <Drawer
        anchor="bottom"
        open={open}
        onClose={close}
        slotProps={{
          paper: {
            id: SHEET_ID,
            "aria-label": t("layers"),
            sx: (theme) => ({
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              maxHeight: "85dvh",
              // The same surface as the other bottom sheets.
              ...theme.applyStyles("dark", { bgcolor: "background.default" }),
            }),
          },
        }}
      >
        <LayerDetailsPanel variant="sheet" onClose={close} />
      </Drawer>
    </>
  );
}
