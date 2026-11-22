"use client";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { AdminServiceSummary, AdminServicesBulkAction } from "@openmapx/core/api-contracts";
import NextLink from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { useAdminTranslations } from "@/lib/admin/adminTranslator";
import { isPreparedByTransitSync, serviceActionReason } from "@/lib/admin/serviceAdmin";

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
  const ids = [...selectedIds];
  const decisionFor = (id: string) =>
    services.find((service) => service.id === id)?.actions?.[action === "stage" ? "pull" : action];
  // A build leaves out the services with nothing to build instead of refusing
  // the whole selection; every other refusal still blocks the action.
  const skipped =
    action === "build" ? ids.filter((id) => decisionFor(id)?.reason === "not_buildable") : [];
  const targets = ids.filter((id) => !skipped.includes(id));
  const denied = targets.filter((id) => {
    const decision = decisionFor(id);
    return Boolean(serviceActionReason(decision, ta)) || decision?.workflow === "core-restart";
  });
  const reason = denied.length
    ? denied.some((id) => decisionFor(id)?.workflow === "core-restart")
      ? ta("unavailableForDeniedUseIndividual", { denied: denied.join(", ") })
      : ta("unavailableForDenied", { denied: denied.join(", ") })
    : skipped.length && !targets.length
      ? ta("nothingSelectedToBuild")
      : action === "stage" && ids.length > 64
        ? ta("stageAtMost64Services")
        : undefined;
  const skippedByTransitSync = skipped.filter(isPreparedByTransitSync);
  const skippedOther = skipped.filter((id) => !isPreparedByTransitSync(id));
  function submit() {
    if (reason || !targets.length || busy) return;
    if (action === "stage") {
      onStage([...targets]);
      return;
    }
    onQueue(
      action === "build"
        ? {
            action,
            serviceIds: [...targets],
            region: region.trim() || undefined,
            continueOnError,
          }
        : action === "update"
          ? { action, serviceIds: [...targets], noDeps }
          : { action, serviceIds: [...targets] },
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
            disabled={busy || !!reason || !targets.length}
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
        {skippedByTransitSync.length > 0 && (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {ta.rich("motisPreparedByTransitSync", {
              link: (chunks) => (
                <Link component={NextLink} href="/admin/data/transit?tab=sources">
                  {chunks}
                </Link>
              ),
            })}
          </Typography>
        )}
        {skippedOther.length > 0 && (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {ta("skippedNotBuildable", { ids: skippedOther.join(", ") })}
          </Typography>
        )}
        <Typography
          variant="caption"
          sx={{ color: reason ? "warning.main" : "text.secondary" }}
          role="status"
        >
          {reason ?? ta("targetsIdsTheseAreAction", { ids: targets.join(", ") })}
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
  disabled,
}: {
  region: string;
  setRegion: (value: string) => void;
  continueOnError: boolean;
  setContinueOnError: (value: boolean) => void;
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
          disabled={busy || !ids.length}
          onClick={() =>
            void onQueue({
              action: "build",
              serviceIds: [...ids],
              region: region.trim() || undefined,
              continueOnError,
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
