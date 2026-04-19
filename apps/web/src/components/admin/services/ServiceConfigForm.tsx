"use client";

import RestartAltIcon from "@mui/icons-material/RestartAlt";
import SaveIcon from "@mui/icons-material/Save";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useMemo, useState } from "react";

interface SchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  format?: string;
}

interface ServiceConfigFormProps {
  serviceId: string;
  schema: Record<string, unknown> | undefined;
  /** Persisted config from `GET /admin/services/:id/config`; merged over defaults. */
  initialValues?: Record<string, unknown>;
  /** Save the new config to the database (no container restart). */
  onSave?: (values: Record<string, unknown>) => Promise<void>;
  /**
   * Save the new config AND restart the service so the change takes effect.
   * Service configs are mounted into the container at start time, so a
   * separate restart is required for the new values to be observed by the
   * running process.
   */
  onSaveAndApply?: (values: Record<string, unknown>) => Promise<void>;
}

function humanize(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]/g, " ")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

function extractFields(schema: Record<string, unknown> | undefined) {
  if (!schema) return [];
  const props = (schema.properties ?? schema) as Record<string, SchemaProperty>;
  return Object.entries(props)
    .filter(([key]) => key !== "type" && key !== "properties")
    .map(([key, def]) => ({
      key,
      title: def?.title ?? humanize(key),
      description: def?.description,
      type: def?.type ?? "string",
      enum: def?.enum,
      format: def?.format,
      default: def?.default,
    }));
}

export function ServiceConfigForm({
  serviceId: _serviceId,
  schema,
  initialValues,
  onSave,
  onSaveAndApply,
}: ServiceConfigFormProps) {
  const fields = useMemo(() => extractFields(schema), [schema]);

  const computeInitialValues = useCallback(() => {
    const initial: Record<string, unknown> = {};
    for (const field of fields) {
      // Persisted values from the DB win over schema defaults.
      const persisted = initialValues?.[field.key];
      initial[field.key] = persisted !== undefined ? persisted : (field.default ?? "");
    }
    return initial;
  }, [fields, initialValues]);

  const [values, setValues] = useState<Record<string, unknown>>(computeInitialValues);
  // `pending` distinguishes which button to spinner. `null` = idle.
  const [pending, setPending] = useState<"save" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<"saved" | "applied" | null>(null);

  useEffect(() => {
    setValues(computeInitialValues());
  }, [computeInitialValues]);

  async function handleSave() {
    setError(null);
    setSaved(null);
    setPending("save");
    try {
      if (onSave) {
        await onSave(values);
      } else {
        console.log("[ServiceConfigForm] onSave not wired yet — values:", values);
      }
      setSaved("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setPending(null);
    }
  }

  async function handleApply() {
    if (!onSaveAndApply) return;
    setError(null);
    setSaved(null);
    setPending("apply");
    try {
      await onSaveAndApply(values);
      setSaved("applied");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save & Apply failed");
    } finally {
      setPending(null);
    }
  }

  const saving = pending !== null;

  if (fields.length === 0) {
    return (
      <Alert severity="info" variant="outlined">
        No editable configuration fields declared for this service.
      </Alert>
    );
  }

  return (
    <Stack gap={2.5}>
      {error && (
        <Alert severity="error" variant="outlined" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {saved === "saved" && (
        <Alert severity="success" variant="outlined" onClose={() => setSaved(null)}>
          Configuration saved. {onSaveAndApply ? "Restart the service to apply." : ""}
        </Alert>
      )}
      {saved === "applied" && (
        <Alert severity="success" variant="outlined" onClose={() => setSaved(null)}>
          Configuration saved and service restart queued.
        </Alert>
      )}

      {fields.map((field) => (
        <Stack key={field.key} gap={0.5}>
          <Typography variant="body2" fontWeight={600}>
            {field.title}
          </Typography>
          {field.description && (
            <Typography variant="caption" color="text.secondary">
              {field.description}
            </Typography>
          )}
          {field.type === "boolean" ? (
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={Boolean(values[field.key])}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [field.key]: e.target.checked }))
                  }
                  disabled={saving}
                />
              }
              label={<Typography variant="body2">{String(values[field.key] ?? false)}</Typography>}
            />
          ) : field.enum ? (
            <Select
              size="small"
              value={String(values[field.key] ?? "")}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              disabled={saving}
              sx={{ maxWidth: 320 }}
            >
              {field.enum.map((opt) => (
                <MenuItem key={opt} value={opt}>
                  {opt}
                </MenuItem>
              ))}
            </Select>
          ) : (
            <TextField
              size="small"
              value={String(values[field.key] ?? "")}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              disabled={saving}
              type={
                field.type === "number" || field.type === "integer"
                  ? "number"
                  : field.format === "url"
                    ? "url"
                    : "text"
              }
              placeholder={field.default !== undefined ? String(field.default) : undefined}
              sx={{ maxWidth: 480 }}
            />
          )}
        </Stack>
      ))}

      <Stack direction="row" gap={1}>
        <Button
          variant="outlined"
          size="small"
          startIcon={pending === "save" ? <CircularProgress size={14} /> : <SaveIcon />}
          onClick={handleSave}
          disabled={saving}
        >
          Save
        </Button>
        {onSaveAndApply && (
          <Button
            variant="contained"
            size="small"
            startIcon={pending === "apply" ? <CircularProgress size={14} /> : <RestartAltIcon />}
            onClick={handleApply}
            disabled={saving}
          >
            Save &amp; Apply (restart)
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
