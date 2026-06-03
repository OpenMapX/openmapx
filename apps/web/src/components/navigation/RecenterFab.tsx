"use client";

import NavigationIcon from "@mui/icons-material/Navigation";
import Fab from "@mui/material/Fab";
import { useTranslations } from "next-intl";

export function RecenterFab({ onClick }: { onClick: () => void }) {
  const t = useTranslations("navigation");
  return (
    <Fab color="primary" size="medium" onClick={onClick} aria-label={t("recenter")}>
      <NavigationIcon />
    </Fab>
  );
}
