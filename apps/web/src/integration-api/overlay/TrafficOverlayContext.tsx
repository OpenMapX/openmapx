"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { TrafficInfo } from "../components/TrafficInfo";

/** These tile formats expose no upstream timestamp or extent completeness. */
export function TrafficOverlayContext({
  hosted,
  visible,
  children,
}: {
  hosted: boolean;
  visible: boolean;
  children?: ReactNode;
}) {
  const t = useTranslations("trafficStatus.overlay");
  return (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
      {!visible && (
        <Typography variant="caption" color="text.secondary">
          {t("hidden")}
        </Typography>
      )}
      <TrafficInfo>
        <Typography variant="body2" sx={{ mb: 1 }}>
          {t(hosted ? "hostedSource" : "ownedSource")}
        </Typography>
        <Typography variant="body2" sx={{ mb: 1 }}>
          {t("ageUnknown")} {t("coverageUnknown")}
        </Typography>
        {!hosted && (
          <Typography variant="body2" sx={{ mb: 1 }}>
            {t("estimates")}
          </Typography>
        )}
        <Typography variant="body2">{t("mapOnly")}</Typography>
        {children}
      </TrafficInfo>
    </Box>
  );
}
