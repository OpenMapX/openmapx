"use client";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useServiceSelection, useServiceSelectionSave, useServicesList } from "@/hooks/useServices";
import { adminErrorText } from "@/lib/admin/adminRequestError";
import { useAdminDraft } from "@/lib/admin/useAdminDraft";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { AdminJobLink } from "../activity/AdminJobLink";
import { useActivityClient } from "../activity/activityQueries";
import { useAdminToast } from "../shared/AdminToast";

const parseRoots = (value: string) =>
  value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
export function ServiceSelectionEditor() {
  const { apiUrl } = useActivityClient();
  return <SelectionEditor key={apiUrl} />;
}
function SelectionEditor() {
  const t = useTranslations("adminServices");
  const selection = useServiceSelection();
  const services = useServicesList();
  const save = useServiceSelectionSave();
  const { client } = useActivityClient();
  const owner = useAdminMutationOwner(client);
  const toast = useAdminToast();
  const [accepted, setAccepted] = useState<string>();
  const baseline = (selection.data?.selectedRoots ?? []).join(", ");
  const locked = selection.data?.source === "env";
  const draft = useAdminDraft({
    id: "service-selection",
    baseline: { roots: baseline },
    editableKeys: locked ? [] : ["roots"],
    signature: "roots-v1",
    ready: !!selection.data,
  });
  const disabled = !selection.data || selection.isError || locked || save.isPending;
  async function persist(roots: string[], submitted: string) {
    try {
      const result = await save.mutateAsync(roots);
      draft.acknowledge({ roots: submitted });
      if (!owner.active) return;
      if ("jobId" in result) setAccepted(String(result.jobId));
      toast(
        "jobId" in result
          ? t("queuedServiceSelectionJobid", { jobId: String(result.jobId) })
          : t("serviceSelectionSaved"),
      );
    } catch (error) {
      if (owner.active) toast(adminErrorText(error, t("saveFailed")), "error");
    }
  }
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack sx={{ gap: 1.5 }}>
        <Typography component="h2" variant="subtitle1" sx={{ fontWeight: 650 }}>
          {t("serviceSelection")}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t("persistentRootsDetermineEnabledServices")}
        </Typography>
        {locked && (
          <Alert severity="warning">
            {t("selectionIsControlledByEnvvarname", {
              envVarName: selection.data?.envVarName ?? "",
            })}
          </Alert>
        )}
        {selection.isError && (
          <Alert
            severity="error"
            action={<Button onClick={() => void selection.refetch()}>{t("retry")}</Button>}
          >
            {t("failedToLoadServiceSelection")}
          </Alert>
        )}
        <TextField
          label={t("selectedRootServiceIds")}
          size="small"
          fullWidth
          value={draft.values.roots ?? baseline}
          onChange={(event) => draft.setValues({ roots: event.target.value })}
          disabled={disabled}
          placeholder={t("appApiValhallaOsrm")}
        />
        {draft.conflicts.length > 0 && (
          <Alert
            severity="warning"
            action={<Button onClick={() => draft.keepEdits()}>{t("keepMyEdits")}</Button>}
          >
            {t("savedServiceRootsChangedReview")}
          </Alert>
        )}
        <Stack direction="row" sx={{ gap: 0.75, flexWrap: "wrap", alignItems: "center" }}>
          <Chip
            size="small"
            variant="outlined"
            label={t("requestedValue", { value: selection.data?.requestedIds.length ?? 0 })}
          />
          <Chip
            size="small"
            variant="outlined"
            label={t("effectiveValue", { value: selection.data?.effectiveIds.length ?? 0 })}
          />
          <Chip
            size="small"
            variant="outlined"
            label={t("sourceValue", { value: selection.data?.source ?? t("sourceUnknown") })}
          />
          <Button
            variant="contained"
            size="small"
            disabled={disabled || !draft.dirty || !!draft.conflicts.length}
            onClick={() => {
              const submitted = String(draft.values.roots ?? "");
              void persist(parseRoots(submitted), submitted);
            }}
          >
            {t("saveSelection")}
          </Button>
          {draft.dirty && (
            <Button size="small" disabled={save.isPending} onClick={() => draft.discard()}>
              {t("discard")}
            </Button>
          )}
        </Stack>
        {!!selection.data?.warnings.length && (
          <Alert severity="warning">{selection.data.warnings.join("; ")}</Alert>
        )}
        {!!selection.data?.missingIds.length && (
          <Alert severity="error">
            {t("missingServiceIdsMissingids", { missingIds: selection.data.missingIds.join(", ") })}
          </Alert>
        )}
        {accepted && <AdminJobLink id={accepted} source="application" />}
        <Accordion disableGutters variant="outlined">
          <AccordionSummary>{t("servicesAndRootControls")}</AccordionSummary>
          <AccordionDetails sx={{ p: 0 }}>
            {services.isError && <Alert severity="error">{t("serviceMembershipCouldNotBe")}</Alert>}
            <TableContainer sx={{ maxHeight: 360 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>{t("service")}</TableCell>
                    <TableCell>{t("membership")}</TableCell>
                    <TableCell>{t("rootControl")}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(services.data?.services ?? []).map((service) => {
                    const root = selection.data?.selectedRoots.includes(service.id);
                    const dependency = service.enabled && !root;
                    const reason = dependency
                      ? t("requiredByASelectedRoot")
                      : draft.dirty
                        ? t("saveOrDiscardRootEdits")
                        : undefined;
                    return (
                      <TableRow key={service.id}>
                        <TableCell>
                          <Button
                            component={Link}
                            href={`/admin/system/services/${encodeURIComponent(service.id)}`}
                            size="small"
                          >
                            {service.name}
                          </Button>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: "block" }}
                          >
                            {service.id}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          {root ? t("root") : dependency ? t("requiredDependency") : t("disabled")}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="small"
                            title={reason}
                            disabled={disabled || dependency || draft.dirty}
                            onClick={() => {
                              const roots = root
                                ? (selection.data?.selectedRoots.filter(
                                    (id) => id !== service.id,
                                  ) ?? [])
                                : [...(selection.data?.selectedRoots ?? []), service.id];
                              void persist(roots, roots.join(", "));
                            }}
                          >
                            {root
                              ? t("removeIdRoot", { id: service.id })
                              : dependency
                                ? t("requiredDependency")
                                : t("enableId", { id: service.id })}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </AccordionDetails>
        </Accordion>
      </Stack>
    </Paper>
  );
}
