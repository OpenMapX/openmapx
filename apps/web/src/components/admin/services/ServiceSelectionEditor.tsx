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
import { useState } from "react";
import { useServiceSelection, useServiceSelectionSave, useServicesList } from "@/hooks/useServices";
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
          ? `Queued service selection (${result.jobId})`
          : "Service selection saved",
      );
    } catch (error) {
      if (owner.active) toast(error instanceof Error ? error.message : "Save failed", "error");
    }
  }
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack sx={{ gap: 1.5 }}>
        <Typography component="h2" variant="subtitle1" sx={{ fontWeight: 650 }}>
          Service selection
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Persistent roots determine enabled services and their dependencies. Removing a root can
          keep it enabled as another root's dependency. Inventory checkboxes select temporary action
          targets.
        </Typography>
        {locked && (
          <Alert severity="warning">
            Selection is controlled by {selection.data?.envVarName}. Remove that host override
            before editing the selection file.
          </Alert>
        )}
        {selection.isError && (
          <Alert
            severity="error"
            action={<Button onClick={() => void selection.refetch()}>Retry</Button>}
          >
            Failed to load service selection
          </Alert>
        )}
        <TextField
          label="Selected root service IDs"
          size="small"
          fullWidth
          value={draft.values.roots ?? baseline}
          onChange={(event) => draft.setValues({ roots: event.target.value })}
          disabled={disabled}
          placeholder="app-api, valhalla, osrm"
        />
        {draft.conflicts.length > 0 && (
          <Alert
            severity="warning"
            action={<Button onClick={() => draft.keepEdits()}>Keep my edits</Button>}
          >
            Saved service roots changed. Review or discard your edits before saving.
          </Alert>
        )}
        <Stack direction="row" sx={{ gap: 0.75, flexWrap: "wrap", alignItems: "center" }}>
          <Chip
            size="small"
            variant="outlined"
            label={`Requested: ${selection.data?.requestedIds.length ?? 0}`}
          />
          <Chip
            size="small"
            variant="outlined"
            label={`Effective: ${selection.data?.effectiveIds.length ?? 0}`}
          />
          <Chip
            size="small"
            variant="outlined"
            label={`Source: ${selection.data?.source ?? "unknown"}`}
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
            Save Selection
          </Button>
          {draft.dirty && (
            <Button size="small" disabled={save.isPending} onClick={() => draft.discard()}>
              Discard
            </Button>
          )}
        </Stack>
        {!!selection.data?.warnings.length && (
          <Alert severity="warning">{selection.data.warnings.join("; ")}</Alert>
        )}
        {!!selection.data?.missingIds.length && (
          <Alert severity="error">
            Missing service IDs: {selection.data.missingIds.join(", ")}
          </Alert>
        )}
        {accepted && <AdminJobLink id={accepted} source="application" />}
        <Accordion disableGutters variant="outlined">
          <AccordionSummary>Services and root controls</AccordionSummary>
          <AccordionDetails sx={{ p: 0 }}>
            {services.isError && (
              <Alert severity="error">
                Service membership could not be loaded. The root editor remains available.
              </Alert>
            )}
            <TableContainer sx={{ maxHeight: 360 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Service</TableCell>
                    <TableCell>Membership</TableCell>
                    <TableCell>Root control</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(services.data?.services ?? []).map((service) => {
                    const root = selection.data?.selectedRoots.includes(service.id);
                    const dependency = service.enabled && !root;
                    const reason = dependency
                      ? "Required by a selected root. Edit the roots to remove that dependency."
                      : draft.dirty
                        ? "Save or discard root edits before changing one service."
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
                          {root ? "Root" : dependency ? "Required dependency" : "Disabled"}
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
                              ? `Remove ${service.id} root`
                              : dependency
                                ? "Required dependency"
                                : `Enable ${service.id}`}
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
