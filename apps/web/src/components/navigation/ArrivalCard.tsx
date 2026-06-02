"use client";

import PlaceIcon from "@mui/icons-material/Place";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";

export function ArrivalCard({ onClose }: { onClose: () => void }) {
  const t = useTranslations("navigation");
  return (
    <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, p: 3 }}>
      <PlaceIcon color="primary" sx={{ fontSize: 48 }} />
      <Typography variant="h6">{t("arrived")}</Typography>
      <Button variant="contained" onClick={onClose}>
        {t("done")}
      </Button>
    </Box>
  );
}
