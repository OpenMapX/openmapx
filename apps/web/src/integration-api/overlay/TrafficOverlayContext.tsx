"use client";

import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";

/** These tile formats expose no upstream timestamp or extent completeness. */
export function TrafficOverlayContext({ hosted, visible }: { hosted: boolean; visible: boolean }) {
  const t = useTranslations("trafficStatus.overlay");
  return (
    <Typography
      component="div"
      variant="caption"
      sx={{ display: "block", mt: 1, color: "text.secondary", overflowWrap: "anywhere" }}
    >
      <span>{t(hosted ? "hostedSource" : "ownedSource")}</span>
      {!visible && (
        <>
          {" "}
          · <span>{t("hidden")}</span>
        </>
      )}
      <br />
      <span>{t("ageUnknown")}</span> · <span>{t("coverageUnknown")}</span>
      {!hosted && (
        <>
          <br />
          <span>{t("estimates")}</span>
        </>
      )}
      <br />
      <span>{t("mapOnly")}</span>
    </Typography>
  );
}
