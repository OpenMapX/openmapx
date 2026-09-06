"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import {
  type AdminOperationContract,
  type AdminOperationField,
  type AdminOperationFormValues,
  AdminOperationInputError,
  type AdminOperationPreview,
  initialFormValues,
  previewAdminOperation,
  runAdminOperation,
} from "./adminOperationsApi";

export interface AdminOperationCardProps {
  apiUrl: string;
  operation: AdminOperationContract;
  onQueued: (jobId: string, operation: AdminOperationContract) => void;
  onError: (message: string) => void;
}

function fieldIssue(
  error: unknown,
  field: AdminOperationField,
): { error: boolean; helperText?: string } {
  if (!(error instanceof AdminOperationInputError)) return { error: false };
  const issue = error.issues.find((candidate) => candidate.path === field.name);
  return issue ? { error: true, helperText: issue.message } : { error: false };
}

function OperationField({
  field,
  value,
  disabled,
  issue,
  onChange,
}: {
  field: AdminOperationField;
  value: string | boolean;
  disabled: boolean;
  issue: { error: boolean; helperText?: string };
  onChange: (value: string | boolean) => void;
}) {
  if (field.kind === "boolean") {
    return (
      <FormControlLabel
        control={
          <Switch
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
        }
        label={field.label}
      />
    );
  }
  return (
    <TextField
      size="small"
      select={field.kind === "select"}
      label={field.label}
      placeholder={field.placeholder}
      required={field.required}
      disabled={disabled}
      value={typeof value === "string" ? value : ""}
      error={issue.error}
      helperText={issue.helperText ?? field.helpText}
      onChange={(event) => onChange(event.target.value)}
    >
      {field.kind === "select"
        ? (field.options ?? []).map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {option.label}
            </MenuItem>
          ))
        : null}
    </TextField>
  );
}

/**
 * Renders one catalog entry as a form. Submitting asks the server for a
 * redacted preview, shows it (with the confirmation copy for destructive
 * operations), and only then queues the job.
 */
export function AdminOperationCard({
  apiUrl,
  operation,
  onQueued,
  onError,
}: AdminOperationCardProps) {
  const [values, setValues] = useState<AdminOperationFormValues>(() =>
    initialFormValues(operation),
  );
  const [preview, setPreview] = useState<AdminOperationPreview | null>(null);
  const destructive = operation.risk === "destructive";

  const previewMutation = useMutation({
    mutationFn: () => previewAdminOperation(apiUrl, operation.id, values),
    onSuccess: (result) => setPreview(result),
    onError: (error) => {
      if (!(error instanceof AdminOperationInputError)) {
        onError(error instanceof Error ? error.message : "Preview failed");
      }
    },
  });

  const runMutation = useMutation({
    mutationFn: () => runAdminOperation(apiUrl, operation.id, values),
    onSuccess: (jobId) => {
      setPreview(null);
      onQueued(jobId, operation);
    },
    onError: (error) => {
      setPreview(null);
      onError(error instanceof Error ? error.message : "Operation failed");
    },
  });

  const busy = previewMutation.isPending || runMutation.isPending;
  const requiredMissing = operation.fields.some(
    (field) =>
      field.required &&
      typeof values[field.name] === "string" &&
      !String(values[field.name]).trim(),
  );

  return (
    <Card variant="outlined" data-operation-id={operation.id}>
      <CardContent>
        <Stack spacing={1.5}>
          <div>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {operation.title}
            </Typography>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {operation.description}
            </Typography>
          </div>
          {operation.fields.map((field) => (
            <OperationField
              key={field.name}
              field={field}
              value={values[field.name] ?? (field.kind === "boolean" ? false : "")}
              disabled={busy}
              issue={fieldIssue(previewMutation.error, field)}
              onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
            />
          ))}
          <Button
            variant="contained"
            color={destructive ? "warning" : "primary"}
            onClick={() => previewMutation.mutate()}
            disabled={busy || requiredMissing}
          >
            Queue {operation.title}
          </Button>
        </Stack>
      </CardContent>
      <Dialog
        open={preview !== null}
        onClose={busy ? undefined : () => setPreview(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{operation.confirmation?.title ?? `Queue ${operation.title}`}</DialogTitle>
        <DialogContent>
          <Stack sx={{ gap: 1.5, pt: 0.5 }}>
            {destructive && operation.confirmation && (
              <Alert severity="warning">{operation.confirmation.message}</Alert>
            )}
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              This job will:
            </Typography>
            <List dense disablePadding>
              {(preview?.preview ?? []).map((line) => (
                <ListItem key={line} disableGutters>
                  <ListItemText primary={line} />
                </ListItem>
              ))}
            </List>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPreview(null)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color={destructive ? "warning" : "primary"}
            disabled={busy}
            onClick={() => runMutation.mutate()}
          >
            {runMutation.isPending ? "Queueing..." : "Confirm"}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
