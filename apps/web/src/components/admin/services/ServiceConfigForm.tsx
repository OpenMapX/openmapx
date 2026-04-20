"use client";

import RestartAltIcon from "@mui/icons-material/RestartAlt";
import SaveIcon from "@mui/icons-material/Save";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ResolvedConfigValue, ServiceConfigSource } from "@/hooks/useServices";

const SOURCE_COLOR: Record<ServiceConfigSource, "default" | "primary" | "success"> = {
  default: "default",
  database: "primary",
  env: "success",
};

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
  /**
   * Resolved per-field values with source annotation (default / database / env).
   * Env-sourced fields are rendered disabled, matching how `ConfigSchemaForm`
   * handles integration config, so operators see at a glance which knobs the
   * host environment is currently dictating.
   */
  resolvedConfig: Record<string, ResolvedConfigValue>;
  /**
   * Env-var prefix the operator can use on the host to override any config
   * field. Shown as a hint in the form header so the convention is discoverable.
   */
  envPrefix?: string;
  /** Save the new config to the database (no container restart). */
  onSave?: (values: Record<string, unknown>) => Promise<void>;
  /**
   * Save the new config AND recreate the service so the change takes effect.
   * Service configs land in the rendered compose env at start time, so a
   * compose up/recreate is required for the new values to be observed by the
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
  resolvedConfig,
  envPrefix,
  onSave,
  onSaveAndApply,
}: ServiceConfigFormProps) {
  const fields = useMemo(() => extractFields(schema), [schema]);

  // Only non-env fields are editable; env-sourced values come from the host.
  const computeInitialValues = useCallback(() => {
    const initial: Record<string, unknown> = {};
    for (const field of fields) {
      const entry = resolvedConfig[field.key];
      if (entry?.source !== "env") {
        initial[field.key] = entry?.value ?? field.default ?? "";
      }
    }
    return initial;
  }, [fields, resolvedConfig]);

  const [values, setValues] = useState<Record<string, unknown>>(computeInitialValues);
  const [pending, setPending] = useState<"save" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<"saved" | "applied" | null>(null);

  useEffect(() => {
    setValues(computeInitialValues());
  }, [computeInitialValues]);

  // Track DB/default starting point so we can surface how many fields changed.
  const originalValues = useMemo(() => {
    const orig: Record<string, unknown> = {};
    for (const field of fields) {
      const entry = resolvedConfig[field.key];
      if (entry?.source !== "env") {
        orig[field.key] = entry?.value ?? field.default ?? "";
      }
    }
    return orig;
  }, [fields, resolvedConfig]);

  const changedKeys = useMemo(
    () =>
      Object.keys(values).filter((k) => {
        const orig = originalValues[k];
        const cur = values[k];
        return String(cur) !== String(orig ?? "");
      }),
    [values, originalValues],
  );

  async function handleSave() {
    if (!onSave) return;
    setError(null);
    setSaved(null);
    setPending("save");
    try {
      const diff: Record<string, unknown> = {};
      for (const k of changedKeys) diff[k] = values[k];
      await onSave(diff);
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
      const diff: Record<string, unknown> = {};
      for (const k of changedKeys) diff[k] = values[k];
      await onSaveAndApply(diff);
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
          Configuration saved. {onSaveAndApply ? "Use Start (recreate) to apply." : ""}
        </Alert>
      )}
      {saved === "applied" && (
        <Alert severity="success" variant="outlined" onClose={() => setSaved(null)}>
          Configuration saved and service (re)start queued.
        </Alert>
      )}

      {envPrefix && (
        <Alert severity="info" variant="outlined" sx={{ py: 0.5 }}>
          <Typography variant="caption">
            Host env vars always win. Override any field below by setting{" "}
            <Box
              component="code"
              sx={{ fontFamily: "monospace", fontSize: "0.78rem", fontWeight: 600 }}
            >
              {envPrefix}&lt;KEY&gt;
            </Box>{" "}
            in the host environment.
          </Typography>
        </Alert>
      )}

      {fields.map((field) => {
        const entry = resolvedConfig[field.key];
        const source: ServiceConfigSource = entry?.source ?? "default";
        const isEnvOverridden = source === "env";
        const displayValue = isEnvOverridden ? entry?.value : values[field.key];

        return (
          <Stack key={field.key} gap={0.5}>
            <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
              <Typography variant="body2" fontWeight={600}>
                {field.title}
              </Typography>
              <Tooltip title={`Currently sourced from: ${source}`}>
                <Chip
                  label={source}
                  size="small"
                  color={SOURCE_COLOR[source] ?? "default"}
                  variant="outlined"
                  sx={{ fontFamily: "monospace", fontSize: "0.7rem" }}
                />
              </Tooltip>
              {isEnvOverridden && (
                <Chip
                  label="env override"
                  size="small"
                  color="success"
                  sx={{ fontSize: "0.7rem" }}
                />
              )}
            </Stack>

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
                    checked={Boolean(displayValue)}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [field.key]: e.target.checked }))
                    }
                    disabled={isEnvOverridden || saving}
                  />
                }
                label={
                  <Typography variant="body2" color={isEnvOverridden ? "text.disabled" : undefined}>
                    {String(displayValue ?? false)}
                  </Typography>
                }
              />
            ) : field.enum ? (
              <Select
                size="small"
                value={String(displayValue ?? "")}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                disabled={isEnvOverridden || saving}
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
                value={String(displayValue ?? "")}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                disabled={isEnvOverridden || saving}
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
        );
      })}

      <Stack direction="row" gap={1}>
        <Button
          variant="outlined"
          size="small"
          startIcon={pending === "save" ? <CircularProgress size={14} /> : <SaveIcon />}
          onClick={handleSave}
          disabled={saving || changedKeys.length === 0 || !onSave}
        >
          Save{changedKeys.length > 0 ? ` (${changedKeys.length} changed)` : ""}
        </Button>
        {onSaveAndApply && (
          <Button
            variant="contained"
            size="small"
            startIcon={pending === "apply" ? <CircularProgress size={14} /> : <RestartAltIcon />}
            onClick={handleApply}
            disabled={saving || changedKeys.length === 0}
          >
            Save &amp; Apply (recreate)
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
