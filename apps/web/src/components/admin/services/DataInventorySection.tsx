"use client";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { AdminServiceData } from "@openmapx/core/api-contracts";
import { formatBytes } from "@/lib/storageFormat";

const targetLabels: Record<string, string> = {
  valhalla: "Valhalla",
  osrm: "OSRM",
  otp: "OpenTripPlanner",
  motis: "MOTIS",
  motisFeedProxy: "MOTIS feed proxy",
  tiles: "Tile server",
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
  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography component="h2" variant="h6">
          OSM extracts
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Download and build workflows record fingerprints. Refreshing inventory never hashes
          dataset contents.
        </Typography>
        {osm.unavailable ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            The OSM inventory could not be inspected completely. Restore access before relying on
            readiness.
          </Alert>
        ) : (
          <>
            {osm.total === 0 ? (
              <Alert severity="info" sx={{ mt: 2 }}>
                No OSM extracts are available.
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
                    <span>{item.region ?? "Region not recorded"}</span> ·{" "}
                    {formatBytes(item.sizeBytes)} · {new Date(item.modifiedAt).toLocaleString()}
                  </Typography>
                  <Typography variant="caption" component="p">
                    SHA-256: {item.sourceFingerprint ?? "No current fingerprint evidence"}
                  </Typography>
                </Box>
              ))
            )}
            <Stack direction="row" sx={{ mt: 2, gap: 1, alignItems: "center", flexWrap: "wrap" }}>
              <Button
                disabled={osm.offset === 0}
                onClick={() => onPageChange(Math.max(0, osm.offset - osm.limit))}
              >
                Previous extracts
              </Button>
              <Typography variant="caption">
                {osm.items.length
                  ? `${osm.offset + 1}–${Math.min(osm.offset + osm.items.length, osm.total)} of ${osm.total}`
                  : `0 on this page (${osm.total} total)`}
              </Typography>
              <Button
                disabled={osm.offset + osm.items.length >= osm.total}
                onClick={() => onPageChange(osm.offset + osm.limit)}
              >
                Next extracts
              </Button>
            </Stack>
          </>
        )}
      </Paper>
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography component="h2" variant="h6">
          Prepared service data
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Ready requires recorded source and output evidence. Legacy records and database-backed
          services require their authoritative checks.
        </Typography>
        {builds.map((build) => (
          <Box key={build.target} sx={{ mt: 2, overflowWrap: "anywhere" }}>
            <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", alignItems: "center" }}>
              <Typography sx={{ fontWeight: 600 }}>
                {targetLabels[build.target] ?? build.target}
              </Typography>
              <Chip
                size="small"
                label={build.readiness}
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
              {build.reason ?? "Recorded outputs and source evidence are current."}
            </Typography>
            <Typography variant="caption" component="p">
              {build.region ?? "Region not recorded"} ·{" "}
              {build.sizeBytes === null ? "Size unknown" : formatBytes(build.sizeBytes)} ·{" "}
              {build.buildRecordVersion === null
                ? "No build record"
                : `Build record v${build.buildRecordVersion}`}
            </Typography>
            {Object.entries(build.runtimeImages).map(([id, image]) => (
              <Typography key={id} variant="caption" component="p">
                {id}: {image}
              </Typography>
            ))}
            {build.sourceFingerprints.map((source) => (
              <Typography key={source.id} variant="caption" component="p">
                Source {source.id}: {source.sha256}
              </Typography>
            ))}
          </Box>
        ))}
      </Paper>
    </Stack>
  );
}
