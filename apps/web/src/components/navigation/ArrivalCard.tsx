"use client";

import LocalParkingIcon from "@mui/icons-material/LocalParking";
import PlaceIcon from "@mui/icons-material/Place";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Snackbar from "@mui/material/Snackbar";
import Typography from "@mui/material/Typography";
import { useNavigationStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useSaveParking } from "@/components/panels/parking/useSaveParking";

/** Modes that end with a parked vehicle. Walking and cycling arrivals do not. */
const PARKING_MODES = new Set(["driving", "motorcycle"]);

export function ArrivalCard({ onClose }: { onClose: () => void }) {
  const t = useTranslations("navigation");
  const tParking = useTranslations("parking");
  const kind = useNavigationStore((s) => s.kind);
  const mode = useNavigationStore((s) => s.mode);
  const { saveHere, isSaving } = useSaveParking();
  const [toast, setToast] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const canPark = kind === "ground" && PARKING_MODES.has(mode);

  const handleSaveParking = async () => {
    const outcome = await saveHere({ source: "arrival" });
    setToast(outcome === "saved" ? tParking("savedToast") : tParking("locationUnavailable"));
    if (outcome === "saved") setSaved(true);
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, p: 3 }}>
      <PlaceIcon color="primary" sx={{ fontSize: 48 }} />
      <Typography variant="h6">{t("arrived")}</Typography>
      <Box sx={{ display: "flex", gap: 1 }}>
        <Button variant="contained" onClick={onClose}>
          {t("done")}
        </Button>
        {canPark && (
          <Button
            startIcon={<LocalParkingIcon />}
            disabled={isSaving || saved}
            onClick={() => void handleSaveParking()}
          >
            {tParking("saveParking")}
          </Button>
        )}
      </Box>
      <Snackbar
        open={toast !== null}
        message={toast}
        autoHideDuration={3000}
        onClose={() => setToast(null)}
      />
    </Box>
  );
}
