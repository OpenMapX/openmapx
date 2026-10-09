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
import {
  AMBIENT_GERMANY_REGION,
  type AmbientBuildProgress,
  type AmbientManifest,
  validateAmbientRegion,
} from "@openmapx/core/ambient-places";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAdminToast } from "../shared/AdminToast";
import { ConfirmDialog } from "../shared/ConfirmDialog";

interface AmbientStatus {
  active: AmbientManifest | null;
  previous: string | null;
  building: boolean;
  lastError: string | null;
  startedAt?: string;
  finishedAt?: string;
  progress?: AmbientBuildProgress | null;
}

export function AmbientPlacesMaintenance({ apiUrl }: { apiUrl: string }) {
  const toast = useAdminToast();
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState("Aachen");
  const [bounds, setBounds] = useState([5.9, 50.65, 6.3, 50.95]);
  const [country, setCountry] = useState(false);
  const queryKey = ["admin", "ambient-places", "status"];
  async function request(action: string, body?: unknown) {
    const response = await fetch(`${apiUrl}/api/admin/ambient-places/${action}`, {
      credentials: "include",
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Ambient publication service unavailable");
    return result;
  }
  const query = useQuery<AmbientStatus>({
    queryKey,
    queryFn: () => request("status"),
    refetchInterval: (q) => (q.state.data?.building ? 2000 : 60_000),
  });
  const operation = useMutation({
    mutationFn: ({ action, body }: { action: string; body: unknown }) =>
      request(action, action === "build" ? validateAmbientRegion(body) : body),
    onSuccess: (_result, variables) => {
      toast(variables.action === "build" ? "Publication queued" : "Publication updated");
      setConfirm(false);
      void client.invalidateQueries({ queryKey });
    },
    onError: (error: Error) => toast(error.message, "error"),
  });
  const status = query.data;
  const active = status?.active;
  const busy = operation.isPending || Boolean(status?.building);
  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h6">Nearby places on the map</Typography>
          <Typography variant="body2" color="text.secondary">
            Publish Germany or a custom region from the existing OSM search index and optional
            Overture snapshot. Failed builds keep the last good map.
          </Typography>
        </Box>
        {(query.isLoading || busy) && <LinearProgress />}
        {query.error && <Alert severity="error">{query.error.message}</Alert>}
        {status?.lastError && <Alert severity="error">{status.lastError}</Alert>}
        {status?.building && status.progress && (
          <Alert severity="info">
            {status.progress.phase === "osm"
              ? "Preparing OSM places"
              : status.progress.phase === "overture"
                ? "Preparing Overture gaps"
                : "Validating snapshot"}
            {" · "}
            {status.progress.processed.toLocaleString()} source rows processed
            {" · "}
            {status.progress.placeCount.toLocaleString()} staged places. The previous map remains
            active until publication succeeds.
          </Alert>
        )}
        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
          <Chip label={active ? `${active.placeCount.toLocaleString()} places` : "Not published"} />
          <Chip
            color={active?.enabled ? "success" : "default"}
            label={active?.enabled ? "Visible" : "Disabled or out of date"}
          />
          <Chip label={active?.sources.overture ? "OSM + Overture" : "OSM only"} />
          {active && <Chip label={`Policy ${active.policyVersion}`} />}
          {active && (
            <Chip
              label={
                active.region.coverage === "germany" ? "Germany coverage" : "Regional coverage"
              }
            />
          )}
        </Stack>
        {active && (
          <Box>
            <Typography variant="body2">
              {active.region.name} · published {new Date(active.publishedAt).toLocaleString()}
            </Typography>
            <Typography variant="caption" sx={{ display: "block", overflowWrap: "anywhere" }}>
              Generation {active.generation}
            </Typography>
            <Typography variant="caption" sx={{ display: "block" }}>
              OSM {active.sources.osm.epoch} · {active.sources.osm.count.toLocaleString()} eligible
              places · snapshot {active.sources.osm.publishedAt}
            </Typography>
            {active.sources.overture && (
              <Typography variant="caption" sx={{ display: "block" }}>
                Overture {active.sources.overture.release} ·{" "}
                {active.sources.overture.count.toLocaleString()} eligible places · snapshot{" "}
                {active.sources.overture.publishedAt}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary">
              Snapshot dates describe imported data, not real-world verification of each place.
            </Typography>
          </Box>
        )}
        {status?.previous && (
          <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
            Previous generation {status.previous}
          </Typography>
        )}
        <RadioGroup
          row
          aria-label="Coverage"
          value={country ? "germany" : "regional"}
          onChange={(event) => setCountry(event.target.value === "germany")}
        >
          <FormControlLabel
            value="regional"
            control={<Radio />}
            label="Custom region"
            disabled={busy}
          />
          <FormControlLabel value="germany" control={<Radio />} label="Germany" disabled={busy} />
        </RadioGroup>
        {country ? (
          <Alert severity="info">
            Prepare the complete europe/germany OSM search snapshot and, when used, the Germany
            Overture snapshot with completed conflation first. Germany publication checks disk space
            and processes bounded batches. Schedule it after source preparation; failed builds keep
            the active map.
          </Alert>
        ) : (
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
            <TextField
              label="Region name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              size="small"
              disabled={busy}
            />
            {["West", "South", "East", "North"].map((label, i) => (
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
          {country
            ? "Germany preset: installed source coverage within the rollout envelope."
            : "Custom region: maximum 0.5° × 0.5°, 100,000 places."}{" "}
          Sources must be ready and no older than 90 days; Overture requires completed conflation.
          Eight generations are retained with a seven-day tile cache lease.
        </Typography>
        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
          <Button
            variant="contained"
            disabled={busy}
            onClick={() =>
              operation.mutate({
                action: "build",
                body: country ? AMBIENT_GERMANY_REGION : { name, bounds },
              })
            }
          >
            {country ? "Publish Germany snapshot" : "Publish map snapshot"}
          </Button>
          <Button
            disabled={busy || !active}
            onClick={() =>
              operation.mutate({ action: "enabled", body: { enabled: !active?.enabled } })
            }
          >
            {active?.enabled ? "Disable" : "Enable"}
          </Button>
          <Button disabled={busy || !status?.previous} onClick={() => setConfirm(true)}>
            Roll back
          </Button>
          <Button disabled={busy} onClick={() => void client.invalidateQueries({ queryKey })}>
            Refresh
          </Button>
        </Stack>
      </Stack>
      <ConfirmDialog
        open={confirm}
        title="Roll back nearby places?"
        message="The map will use the previous generation. Cached tiles remain available."
        confirmLabel="Roll back"
        loading={operation.isPending}
        onConfirm={() => operation.mutate({ action: "rollback", body: {} })}
        onCancel={() => setConfirm(false)}
      />
    </Paper>
  );
}
