"use client";

import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import { type AirportTypeFilter, useAirportsOverlayStore } from "./store";

const TYPE_SWATCHES: Array<{ key: string; color: string }> = [
  { key: "large", color: "#0ea5e9" },
  { key: "medium", color: "#3b82f6" },
  { key: "small", color: "#6366f1" },
  { key: "seaplane", color: "#0891b2" },
  { key: "heliport", color: "#f97316" },
];

export function AirportsOverlayLegend() {
  const t = useTranslations("airportsOverlay");
  const registry = useIntegrationRegistry();
  const attributionSource = registry
    .get("overlay-ourairports")
    ?.dataSources?.find((ds) => ds.sourceId === "ourairports");
  const panelOpen = useAirportsOverlayStore((s) => s.panelOpen);
  const layerVisible = useAirportsOverlayStore((s) => s.layerVisible);
  const loading = useAirportsOverlayStore((s) => s.loading);
  const filter = useAirportsOverlayStore((s) => s.filter);
  const setLayerVisible = useAirportsOverlayStore((s) => s.setLayerVisible);
  const setFilter = useAirportsOverlayStore((s) => s.setFilter);

  if (!panelOpen) return null;

  const handleFilter = (_e: unknown, value: AirportTypeFilter | null) => {
    if (value !== null) setFilter(value);
  };

  return (
    <Paper
      elevation={3}
      sx={{
        position: "relative",
        px: 2,
        py: 1.5,
        borderRadius: "12px",
        overflow: "hidden",
        maxWidth: "calc(100vw - 24px)",
      }}
    >
      {loading && (
        <LinearProgress
          sx={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            borderRadius: "12px 12px 0 0",
          }}
        />
      )}

      <Box
        sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 0.75 }}
      >
        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{t("title")}</Typography>
        <Switch
          size="small"
          checked={layerVisible}
          onChange={(e) => setLayerVisible(e.target.checked)}
          inputProps={{ "aria-label": t("toggleOverlay") }}
          sx={{ ml: 2 }}
        />
      </Box>

      <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start", flexWrap: "wrap" }}>
        <Box>
          <Typography sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.3 }}>
            {t("filterLabel")}
          </Typography>
          <ToggleButtonGroup
            value={filter}
            exclusive
            onChange={handleFilter}
            size="small"
            sx={{ height: 26 }}
          >
            <ToggleButton
              value="scheduled"
              sx={{ fontSize: 10.5, px: 1, py: 0, textTransform: "none", minWidth: 0 }}
            >
              {t("filterScheduled")}
            </ToggleButton>
            <ToggleButton
              value="ifr"
              sx={{ fontSize: 10.5, px: 1, py: 0, textTransform: "none", minWidth: 0 }}
            >
              {t("filterIfr")}
            </ToggleButton>
            <ToggleButton
              value="all"
              sx={{ fontSize: 10.5, px: 1, py: 0, textTransform: "none", minWidth: 0 }}
            >
              {t("filterAll")}
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>

        <Box>
          <Typography sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.3 }}>
            {t("typesLabel")}
          </Typography>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "auto auto",
              columnGap: 1,
              rowGap: 0.25,
              alignItems: "center",
            }}
          >
            {TYPE_SWATCHES.map(({ key, color }) => (
              <Box key={key} sx={{ display: "contents" }}>
                <Box
                  sx={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    bgcolor: color,
                    border: "1px solid #fff",
                  }}
                />
                <Typography sx={{ fontSize: 10.5, color: "text.secondary" }}>
                  {t(`type_${key}`)}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>

      {attributionSource && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ mt: 1, display: "block", fontSize: 10 }}
        >
          ©{" "}
          <Link
            href={attributionSource.url}
            target="_blank"
            rel="noopener noreferrer"
            underline="hover"
            color="inherit"
          >
            {attributionSource.name}
          </Link>
          {attributionSource.license && (
            <>
              {" ("}
              {attributionSource.licenseUrl ? (
                <Link
                  href={attributionSource.licenseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  underline="hover"
                  color="inherit"
                >
                  {attributionSource.license}
                </Link>
              ) : (
                attributionSource.license
              )}
              {")"}
            </>
          )}
        </Typography>
      )}
    </Paper>
  );
}

export default AirportsOverlayLegend;
