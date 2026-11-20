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
import { useTranslations } from "next-intl";
import { useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { useAdminTranslations } from "@/lib/admin/adminTranslator";
import { serviceActionReason } from "@/lib/admin/serviceAdmin";

type Action = AdminServicesBulkAction["action"] | "stage";
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
  const ta = useAdminTranslations("adminServices");
  const labels: Record<Action, string> = {
    start: ta("bulkStart"),
    stop: ta("bulkStop"),
    restart: ta("bulkRestart"),
    update: ta("bulkUpdate"),
    build: ta("bulkBuild"),
    stage: ta("bulkStage"),
  };
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
    return Boolean(serviceActionReason(decision, ta)) || decision?.workflow === "core-restart";
  });
  const reason = denied.length
    ? ta("unavailableForDeniedUseIndividual", { denied: denied.join(", ") })
    : action === "build" && motisImport && !selectedIds.has("motis")
      ? ta("motisImportNeedsMotis")
      : action === "stage" && ids.length > 64
        ? ta("stageAtMost64Services")
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
            {ta("selectedCount", { count: ids.length })}
          </Typography>
          <TextField
            select
            size="small"
            label={ta("action")}
            value={action}
            disabled={busy}
            onChange={(event) => setAction(event.target.value as Action)}
            sx={{ minWidth: 175 }}
          >
            {(Object.keys(labels) as Action[]).map((value) => (
              <MenuItem key={value} value={value}>
                {labels[value]}
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
            {labels[action]}
          </Button>
          <Button size="small" disabled={busy} onClick={onClear}>
            {ta("clearSelection")}
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
            label={ta("updateWithoutDependencyRecreation")}
          />
        )}
        <Typography
          variant="caption"
          color={reason ? "warning.main" : "text.secondary"}
          role="status"
        >
          {reason ?? ta("targetsIdsTheseAreAction", { ids: ids.join(", ") })}
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
  const ta = useAdminTranslations("adminServices");
  return (
    <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
      <TextField
        size="small"
        label={ta("buildRegion")}
        placeholder={ta("optional")}
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
        label={ta("continueOnBuildErrors")}
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={motisImport}
            disabled={disabled}
            onChange={(event) => setMotisImport(event.target.checked)}
          />
        }
        label={ta("importMotisAfterBuild")}
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
  const t = useTranslations("adminNavigation.buildAll");
  const [region, setRegion] = useState("");
  const [continueOnError, setContinueOnError] = useState(true);
  const [motisImport, setMotisImport] = useState(false);
  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("title")}</DialogTitle>
      <DialogContent>
        <Stack sx={{ gap: 2, pt: 1 }}>
          <Typography>{t("targets", { count: ids.length, ids: ids.join(", ") })}</Typography>
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
          {t("cancel")}
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
          {t("confirm")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
