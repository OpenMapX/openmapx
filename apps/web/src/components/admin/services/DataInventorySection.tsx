"use client";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { AdminServiceData } from "@openmapx/core/api-contracts";
import { useTranslations } from "next-intl";
import { useAdminFormat } from "@/lib/admin/adminFormat";

/** Product names, which read the same in every language. */
const PRODUCT_NAMES: Record<string, string> = {
  valhalla: "Valhalla",
  osrm: "OSRM",
  otp: "OpenTripPlanner",
  motis: "MOTIS",
  pelias: "Pelias",
  nominatim: "Nominatim",
  photon: "Photon",
  overpass: "Overpass",
};
export function DataInventorySection({
  osm,
  builds,
  onPageChange,
}: {
  osm: AdminServiceData["osm"];
  builds: AdminServiceData["builds"];
  onPageChange: (offset: number) => void;
}) {
  const t = useTranslations("adminServices");
  const format = useAdminFormat();
  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography component="h2" variant="h6">
          {t("osmExtracts")}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t("downloadAndBuildWorkflowsRecord")}
        </Typography>
        {osm.unavailable ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {t("theOsmInventoryCouldNot")}
          </Alert>
        ) : (
          <>
            {osm.total === 0 ? (
              <Alert severity="info" sx={{ mt: 2 }}>
                {t("noOsmExtractsAreAvailable")}
              </Alert>
            ) : (
              osm.items.map((item) => (
                <Box key={item.artifactId} sx={{ mt: 2, overflowWrap: "anywhere" }}>
                  <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", alignItems: "center" }}>
                    <Typography sx={{ fontFamily: "monospace" }}>{item.filename}</Typography>
                    <Chip
                      size="small"
                      label={item.fingerprintState}
                      color={
                        item.fingerprintState === "verified"
                          ? "success"
                          : item.fingerprintState === "stale"
                            ? "warning"
                            : "default"
                      }
                    />
                  </Stack>
                  <Typography variant="body2">
                    {t("extractSummary", {
                      region: item.region ?? t("regionNotRecorded"),
                      size: format.bytes(item.sizeBytes),
                      modifiedAt: format.dateTime(item.modifiedAt),
                    })}
                  </Typography>
                  <Typography variant="caption" component="p">
                    {item.sourceFingerprint
                      ? t("sourceFingerprint", { digest: item.sourceFingerprint })
                      : t("noCurrentFingerprintEvidence")}
                  </Typography>
                </Box>
              ))
            )}
            <Stack direction="row" sx={{ mt: 2, gap: 1, alignItems: "center", flexWrap: "wrap" }}>
              <Button
                disabled={osm.offset === 0}
                onClick={() => onPageChange(Math.max(0, osm.offset - osm.limit))}
              >
                {t("previousExtracts")}
              </Button>
              <Typography variant="caption">
                {osm.items.length
                  ? t("pageRange", {
                      from: osm.offset + 1,
                      to: Math.min(osm.offset + osm.items.length, osm.total),
                      total: osm.total,
                    })
                  : t("emptyPageOfTotal", { total: osm.total })}
              </Typography>
              <Button
                disabled={osm.offset + osm.items.length >= osm.total}
                onClick={() => onPageChange(osm.offset + osm.limit)}
              >
                {t("nextExtracts")}
              </Button>
            </Stack>
          </>
        )}
      </Paper>
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography component="h2" variant="h6">
          {t("preparedServiceData")}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t("readyRequiresRecordedSourceAnd")}
        </Typography>
        {builds.map((build) => (
          <Box key={build.target} sx={{ mt: 2, overflowWrap: "anywhere" }}>
            <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", alignItems: "center" }}>
              <Typography sx={{ fontWeight: 600 }}>
                {build.target === "tiles"
                  ? t("targetTileServer")
                  : build.target === "motisFeedProxy"
                    ? t("targetMotisFeedProxy")
                    : (PRODUCT_NAMES[build.target] ?? build.target)}
              </Typography>
              <Chip
                size="small"
                label={t("buildReadiness", { readiness: build.readiness })}
                color={
                  build.readiness === "ready"
                    ? "success"
                    : build.readiness === "stale"
                      ? "warning"
                      : "default"
                }
              />
            </Stack>
            <Typography variant="body2">
              {build.reason ?? t("recordedOutputsAndSourceEvidence")}
            </Typography>
            <Typography variant="caption" component="p">
              {build.region ?? t("regionNotRecorded")} ·{" "}
              {build.sizeBytes === null ? t("sizeUnknown") : format.bytes(build.sizeBytes)} ·{" "}
              {build.buildRecordVersion === null
                ? t("noBuildRecord")
                : t("buildRecordVersion", {
                    version: build.buildRecordVersion,
                  })}
            </Typography>
            {Object.entries(build.runtimeImages).map(([id, image]) => (
              <Typography key={id} variant="caption" component="p">
                {id}: {image}
              </Typography>
            ))}
            {build.sourceFingerprints.map((source) => (
              <Typography key={source.id} variant="caption" component="p">
                {t("sourceDigest", { id: source.id, digest: source.sha256 })}
              </Typography>
            ))}
          </Box>
        ))}
      </Paper>
    </Stack>
  );
}
