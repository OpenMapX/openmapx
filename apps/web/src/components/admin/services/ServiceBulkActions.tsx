"use client";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { AdminServiceSummary, AdminServicesBulkAction } from "@openmapx/core/api-contracts";
import { useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { serviceActionReason } from "@/lib/admin/serviceAdmin";

type Action = AdminServicesBulkAction["action"] | "stage";
const LABELS: Record<Action, string> = {
  start: "Start Selected",
  stop: "Stop Selected",
  restart: "Restart Selected",
  update: "Update selected",
  build: "Build Selected",
  stage: "Stage selected images",
};
export function ServiceBulkActions({
  services,
  selectedIds,
  busy,
  onQueue,
  onStage,
  onClear,
}: {
  services: AdminServiceSummary[];
  selectedIds: ReadonlySet<string>;
  busy: boolean;
  onQueue: (payload: AdminServicesBulkAction) => void;
  onStage: (ids: string[]) => void;
  onClear: () => void;
}) {
  const [action, setAction] = useState<Action>("start");
  const [region, setRegion] = useState("");
  const [continueOnError, setContinueOnError] = useState(true);
  const [noDeps, setNoDeps] = useState(false);
  const [motisImport, setMotisImport] = useState(false);
  const ids = [...selectedIds];
  const denied = ids.filter((id) => {
    const decision = services.find((service) => service.id === id)?.actions?.[
      action === "stage" ? "pull" : action
    ];
    return Boolean(serviceActionReason(decision)) || decision?.workflow === "core-restart";
  });
  const reason = denied.length
    ? `Unavailable for: ${denied.join(", ")}. Use individual core Restart where available.`
    : action === "build" && motisImport && !selectedIds.has("motis")
      ? "MOTIS import requires selecting MOTIS"
      : action === "stage" && ids.length > 64
        ? "Stage at most 64 services at once"
        : undefined;
  function submit() {
    if (reason || !ids.length || busy) return;
    if (action === "stage") {
      onStage([...ids]);
      return;
    }
    onQueue(
      action === "build"
        ? {
            action,
            serviceIds: [...ids],
            region: region.trim() || undefined,
            continueOnError,
            ...(motisImport ? { motisImport: true } : {}),
          }
        : action === "update"
          ? { action, serviceIds: [...ids], noDeps }
          : { action, serviceIds: [...ids] },
    );
  }
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack sx={{ gap: 1.25 }}>
        <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", alignItems: "center" }}>
          <Typography variant="body2" sx={{ fontWeight: 650 }}>
            {ids.length} selected
          </Typography>
          <TextField
            select
            size="small"
            label="Action"
            value={action}
            disabled={busy}
            onChange={(event) => setAction(event.target.value as Action)}
            sx={{ minWidth: 175 }}
          >
            {(Object.keys(LABELS) as Action[]).map((value) => (
              <MenuItem key={value} value={value}>
                {LABELS[value]}
              </MenuItem>
            ))}
          </TextField>
          <Button
            variant="contained"
            size="small"
            title={reason}
            disabled={busy || !!reason}
            onClick={submit}
          >
            {LABELS[action]}
          </Button>
          <Button size="small" disabled={busy} onClick={onClear}>
            Clear selection
          </Button>
        </Stack>
        {action === "build" && (
          <BuildOptions
            region={region}
            setRegion={setRegion}
            continueOnError={continueOnError}
            setContinueOnError={setContinueOnError}
            motisImport={motisImport}
            setMotisImport={setMotisImport}
            disabled={busy}
          />
        )}
        {action === "update" && (
          <FormControlLabel
            control={
              <Checkbox
                checked={noDeps}
                disabled={busy}
                onChange={(event) => setNoDeps(event.target.checked)}
              />
            }
            label="Update without dependency recreation"
          />
        )}
        <Typography
          variant="caption"
          color={reason ? "warning.main" : "text.secondary"}
          role="status"
        >
          {reason ??
            `Targets: ${ids.join(", ")}. These are action targets; persistent roots stay unchanged.`}
        </Typography>
      </Stack>
    </Paper>
  );
}
function BuildOptions({
  region,
  setRegion,
  continueOnError,
  setContinueOnError,
  motisImport,
  setMotisImport,
  disabled,
}: {
  region: string;
  setRegion: (value: string) => void;
  continueOnError: boolean;
  setContinueOnError: (value: boolean) => void;
  motisImport: boolean;
  setMotisImport: (value: boolean) => void;
  disabled: boolean;
}) {
  return (
    <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
      <TextField
        size="small"
        label="Build region"
        placeholder="optional"
        value={region}
        disabled={disabled}
        onChange={(event) => setRegion(event.target.value)}
        sx={{ width: { xs: "100%", sm: 220 } }}
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={continueOnError}
            disabled={disabled}
            onChange={(event) => setContinueOnError(event.target.checked)}
          />
        }
        label="Continue on build errors"
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={motisImport}
            disabled={disabled}
            onChange={(event) => setMotisImport(event.target.checked)}
          />
        }
        label="Import MOTIS after build"
      />
    </Stack>
  );
}
/** Target IDs are captured once at opening; list/filter refreshes cannot expand them. */
export function ServiceBuildAllDialog({
  ids,
  busy,
  onQueue,
  onClose,
}: {
  ids: string[];
  busy: boolean;
  onQueue: (payload: AdminServicesBulkAction) => Promise<boolean>;
  onClose: () => void;
}) {
  const [region, setRegion] = useState("");
  const [continueOnError, setContinueOnError] = useState(true);
  const [motisImport, setMotisImport] = useState(false);
  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Build all enabled services</DialogTitle>
      <DialogContent>
        <Stack sx={{ gap: 2, pt: 1 }}>
          <Typography>
            Build these {ids.length} captured targets: {ids.join(", ")}. The server enforces each
            service's build prerequisites. Newly enabled services will not be added to this request.
          </Typography>
          <BuildOptions
            region={region}
            setRegion={setRegion}
            continueOnError={continueOnError}
            setContinueOnError={setContinueOnError}
            motisImport={motisImport}
            setMotisImport={setMotisImport}
            disabled={busy}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={busy || !ids.length || (motisImport && !ids.includes("motis"))}
          onClick={() =>
            void onQueue({
              action: "build",
              serviceIds: [...ids],
              region: region.trim() || undefined,
              continueOnError,
              ...(motisImport ? { motisImport: true } : {}),
            }).then((accepted) => {
              if (accepted) onClose();
            })
          }
        >
          Build reviewed targets
        </Button>
      </DialogActions>
    </Dialog>
  );
}
