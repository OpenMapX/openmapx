"use client";

import SaveIcon from "@mui/icons-material/Save";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
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
  onSave?: (values: Record<string, unknown>) => Promise<void>;
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
  onSave,
}: ServiceConfigFormProps) {
  const fields = useMemo(() => extractFields(schema), [schema]);

  const computeInitialValues = useCallback(() => {
    const initial: Record<string, unknown> = {};
    for (const field of fields) {
      initial[field.key] = field.default ?? "";
    }
    return initial;
  }, [fields]);

  const [values, setValues] = useState<Record<string, unknown>>(computeInitialValues);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setValues(computeInitialValues());
  }, [computeInitialValues]);

  async function handleSave() {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      if (onSave) {
        await onSave(values);
      } else {
        console.log("[ServiceConfigForm] onSave not wired yet — values:", values);
      }
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

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
      {saved && (
        <Alert severity="success" variant="outlined" onClose={() => setSaved(false)}>
          Configuration saved.
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

      <Box>
        <Button
          variant="contained"
          size="small"
          startIcon={saving ? <CircularProgress size={14} /> : <SaveIcon />}
          onClick={handleSave}
          disabled={saving}
        >
          Save
        </Button>
      </Box>
    </Stack>
  );
}
