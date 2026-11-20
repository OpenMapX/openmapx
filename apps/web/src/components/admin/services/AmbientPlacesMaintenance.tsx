"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import FormControlLabel from "@mui/material/FormControlLabel";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { createApiClient } from "@openmapx/core";
import {
  AMBIENT_GERMANY_REGION,
  AMBIENT_PLANET_REGION,
  type AmbientRegion,
  validateAmbientRegion,
} from "@openmapx/core/ambient-places";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { AmbientPlacesStatus } from "@openmapx/core/api-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { adminErrorText } from "@/lib/admin/adminRequestError";
import { useAdminToast } from "../shared/AdminToast";
import { ConfirmDialog } from "../shared/ConfirmDialog";

type AmbientMutation =
  | { action: "build"; body: Omit<AmbientRegion, "bounds"> & { bounds: readonly number[] } }
  | { action: "resume" | "discard"; body: { generation: string } }
  | { action: "enabled"; body: { enabled: boolean } }
  | { action: "rollback"; body: Record<string, never> };

export function AmbientPlacesMaintenance({ apiUrl }: { apiUrl: string }) {
  const t = useTranslations("adminServices");
  const toast = useAdminToast();
  const client = useQueryClient();
  const apiClient = useMemo(
    () => createApiClient({ baseUrl: apiUrl, credentials: "include" }),
    [apiUrl],
  );
  const [confirm, setConfirm] = useState<"rollback" | "discard" | null>(null);
  const [name, setName] = useState("Aachen");
  const [bounds, setBounds] = useState([5.9, 50.65, 6.3, 50.95]);
  const [coverage, setCoverage] = useState("regional");
  const country = coverage === "germany";
  const planet = coverage === "planet";
  const queryKey = ["admin", "ambient-places", "status"];
  const query = useQuery<AmbientPlacesStatus>({
    queryKey,
    queryFn: async ({ signal }) =>
      sdk.unwrapAdminResponse(
        await sdk.getApiAdminAmbientPlacesStatus({ client: apiClient, signal }),
      ),
    refetchInterval: (q) => (q.state.data?.building ? 2000 : 60_000),
  });
  const operation = useMutation({
    mutationFn: async (input: AmbientMutation) => {
      const options = { client: apiClient };
      const response = await (() => {
        switch (input.action) {
          case "build":
            return sdk.postApiAdminAmbientPlacesBuild(validateAmbientRegion(input.body), options);
          case "resume":
            return sdk.postApiAdminAmbientPlacesResume(input.body, options);
          case "discard":
            return sdk.postApiAdminAmbientPlacesDiscard(input.body, options);
          case "enabled":
            return sdk.postApiAdminAmbientPlacesEnabled(input.body, options);
          case "rollback":
            return sdk.postApiAdminAmbientPlacesRollback(options);
        }
      })();
      return sdk.unwrapAdminResponse(response);
    },
    onSuccess: (_result, variables) => {
      toast(
        ["build", "resume"].includes(variables.action)
          ? t("publicationQueued")
          : t("publicationUpdated"),
      );
      setConfirm(null);
      void client.invalidateQueries({ queryKey });
    },
    onError: (error: Error) => toast(adminErrorText(error, t("serviceRequestFailed")), "error"),
  });
  const status = query.data;
  const active = status?.active;
  const candidate = status?.candidate;
  const busy = operation.isPending || Boolean(status?.building);
  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h6">{t("nearbyPlacesOnTheMap")}</Typography>
          <Typography variant="body2" color="text.secondary">
            {t("publishPlanetGermanyOrA")}
          </Typography>
        </Box>
        {(query.isLoading || busy) && <LinearProgress />}
        {query.error && (
          <Alert severity="error">{adminErrorText(query.error, t("serviceRequestFailed"))}</Alert>
        )}
        {status?.lastError && <Alert severity="error">{status.lastError}</Alert>}
        {status?.building && status.progress && (
          <Alert severity="info">
            {status.progress.phase === "osm"
              ? t("preparingOsmPlaces")
              : status.progress.phase === "overture"
                ? t("preparingOvertureGaps")
                : t("validatingSnapshot")}
            {" · "}
            {t("processedSourceRows", {
              count: status.progress.processed,
            })}
            {" · "}
            {t("stagedPlaces", {
              count: status.progress.placeCount,
            })}
          </Alert>
        )}
        {status?.candidate && !status.building && (
          <Alert severity="warning">
            {t("interruptedPlanetCandidate", {
              processed: status.candidate.checkpoint.processed,
              places: status.candidate.checkpoint.placeCount,
            })}
          </Alert>
        )}
        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
          <Chip
            label={active ? t("placeCount", { count: active.placeCount }) : t("notPublished")}
          />
          <Chip
            color={active?.enabled ? "success" : "default"}
            label={active?.enabled ? t("visible") : t("disabledOrOutOfDate")}
          />
          <Chip label={active?.sources.overture ? t("osmOverture") : t("osmOnly")} />
          {active && <Chip label={t("policyVersion", { version: active.policyVersion })} />}
          {active && (
            <Chip
              label={
                active.region.coverage === "planet"
                  ? t("planetCoverage")
                  : active.region.coverage === "germany"
                    ? t("germanyCoverage")
                    : t("regionalCoverage")
              }
            />
          )}
        </Stack>
        {active && (
          <Box>
            <Typography variant="body2">
              {t("publishedSnapshot", {
                name: active.region.name,
                publishedAt: new Date(active.publishedAt).toLocaleString(),
              })}
            </Typography>
            <Typography variant="caption" sx={{ display: "block", overflowWrap: "anywhere" }}>
              {t("generationGeneration", { generation: active.generation })}
            </Typography>
            <Typography variant="caption" sx={{ display: "block" }}>
              {t("osmSnapshot", {
                epoch: active.sources.osm.epoch,
                count: active.sources.osm.count,
                publishedAt: active.sources.osm.publishedAt,
              })}
            </Typography>
            {active.sources.overture && (
              <Typography variant="caption" sx={{ display: "block" }}>
                {t("overtureSnapshot", {
                  release: active.sources.overture.release,
                  count: active.sources.overture.count,
                  publishedAt: active.sources.overture.publishedAt,
                })}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary">
              {t("snapshotDatesDescribeImportedData")}
            </Typography>
          </Box>
        )}
        {status?.previous && (
          <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
            {t("previousGenerationPrevious", { previous: status.previous })}
          </Typography>
        )}
        <RadioGroup
          row
          aria-label={t("coverage")}
          value={coverage}
          onChange={(event) => setCoverage(event.target.value)}
        >
          <FormControlLabel
            value="regional"
            control={<Radio />}
            label={t("customRegion")}
            disabled={busy}
          />
          <FormControlLabel
            value="germany"
            control={<Radio />}
            label={t("germany")}
            disabled={busy}
          />
          <FormControlLabel
            value="planet"
            control={<Radio />}
            label={t("planet")}
            disabled={busy}
          />
        </RadioGroup>
        {planet ? (
          <Alert severity="info">{t("prepareTheFullPlanetOsm")}</Alert>
        ) : country ? (
          <Alert severity="info">{t("prepareTheCompleteEuropeGermany")}</Alert>
        ) : (
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
            <TextField
              label={t("regionName")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              size="small"
              disabled={busy}
            />
            {[t("west"), t("south"), t("east"), t("north")].map((label, i) => (
              <TextField
                key={label}
                label={label}
                type="number"
                value={bounds[i]}
                onChange={(e) =>
                  setBounds((b) => b.map((v, j) => (i === j ? Number(e.target.value) : v)))
                }
                size="small"
                disabled={busy}
                slotProps={{ htmlInput: { step: 0.01 } }}
              />
            ))}
          </Stack>
        )}
        <Typography variant="caption" color="text.secondary">
          {planet
            ? t("planetPresetInstalledSourceCoverage")
            : country
              ? t("germanyPresetInstalledSourceCoverage")
              : t("customRegionLimits")}{" "}
          {t("ambientSourceRequirements")}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
          <Button
            variant="contained"
            disabled={busy || Boolean(status?.candidate)}
            onClick={() =>
              operation.mutate({
                action: "build",
                body: planet
                  ? AMBIENT_PLANET_REGION
                  : country
                    ? AMBIENT_GERMANY_REGION
                    : { name, bounds },
              })
            }
          >
            {planet
              ? t("publishPlanetSnapshot")
              : country
                ? t("publishGermanySnapshot")
                : t("publishMapSnapshot")}
          </Button>
          <Button
            disabled={busy || !active}
            onClick={() =>
              operation.mutate({ action: "enabled", body: { enabled: !active?.enabled } })
            }
          >
            {active?.enabled ? t("disable") : t("enable")}
          </Button>
          <Button disabled={busy || !status?.previous} onClick={() => setConfirm("rollback")}>
            {t("rollBack")}
          </Button>
          {candidate && (
            <>
              <Button
                disabled={busy}
                onClick={() =>
                  operation.mutate({
                    action: "resume",
                    body: { generation: candidate.generation },
                  })
                }
              >
                {t("resumePlanetBuild")}
              </Button>
              <Button disabled={busy} onClick={() => setConfirm("discard")}>
                {t("discardCandidate")}
              </Button>
            </>
          )}
          <Button disabled={busy} onClick={() => void client.invalidateQueries({ queryKey })}>
            {t("refresh")}
          </Button>
        </Stack>
      </Stack>
      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === "discard" ? t("discardUnpublishedPlanetCandidate") : t("rollBackNearbyPlaces")
        }
        message={confirm === "discard" ? t("theSavedCandidateAndIts") : t("theMapWillUseThe")}
        confirmLabel={confirm === "discard" ? t("discard") : t("rollBack")}
        loading={operation.isPending}
        onConfirm={() => {
          if (confirm === "discard") {
            if (status?.candidate)
              operation.mutate({
                action: "discard",
                body: { generation: status.candidate.generation },
              });
          } else operation.mutate({ action: "rollback", body: {} });
        }}
        onCancel={() => setConfirm(null)}
      />
    </Paper>
  );
}
