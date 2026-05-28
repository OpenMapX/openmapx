"use client";

import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { useCategorySearchStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

/**
 * Entry point for Explore travel-time: a single toggle that activates the shared
 * travel-time tool (the floating TravelTimeToolbar + isochrone layer) in anchored
 * mode, seeded to the searched place. Mode/minutes/reach live on the floating
 * toolbar; this just turns it on/off and keeps the origin synced to the anchor.
 */
export function ExploreTravelTimeControl() {
  const t = useTranslations("search");
  const anchor = useCategorySearchStore((s) => s.anchor);
  const isActive = useTravelTimeStore((s) => s.isActive);
  const anchored = useTravelTimeStore((s) => s.anchored);

  const on = isActive && anchored;

  // Keep the origin pinned to the anchor when Explore re-anchors to a new place.
  useEffect(() => {
    const tt = useTravelTimeStore.getState();
    if (tt.isActive && tt.anchored && anchor) tt.setOrigin(anchor.coordinates);
  }, [anchor]);

  // Turn the floating tool off when leaving Explore (panel unmounts).
  useEffect(() => {
    return () => {
      const tt = useTravelTimeStore.getState();
      if (tt.anchored) tt.deactivate();
    };
  }, []);

  const handleToggle = (checked: boolean) => {
    const tt = useTravelTimeStore.getState();
    if (checked && anchor) tt.activateAnchored(anchor.coordinates);
    else tt.deactivate();
  };

  return (
    <FormControlLabel
      control={
        <Switch size="small" checked={on} onChange={(e) => handleToggle(e.target.checked)} />
      }
      label={
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {t("travelTime")}
        </Typography>
      }
    />
  );
}
