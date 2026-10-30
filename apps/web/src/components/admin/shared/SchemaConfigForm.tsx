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
import type { ConfigurationOwnership } from "@openmapx/core/api-contracts";
import { OPERATOR_STRING_FORMATS, validOperatorString } from "@openmapx/core/configuration-values";
import { type CredentialSetup, readCredentialSetup } from "@openmapx/integration-framework";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CredentialSetupGuide } from "../integrations/CredentialSetupGuide";

// The shared, schema-driven config form used by BOTH the integration and the
// service admin tabs. It renders non-secret configSchema fields from a resolved
// (value + source) map, badges each field's source, disables env-overridden
// fields, diffs changed keys, and persists via the caller's async callback(s).
//
// Secret fields (`x-openmapx-secret: true`) are deliberately excluded here —
// they live only on the Credentials tab. Each consumer keeps its own save
// wrapper (integration: PATCH + reload; service: save vs save-and-apply).

export type ConfigFieldSource = "default" | "database" | "vault" | "config.json" | "env";

const SOURCE_COLOR: Record<
  ConfigFieldSource,
  "default" | "primary" | "secondary" | "success" | "info"
> = {
  default: "default",
  database: "primary",
  vault: "info",
  "config.json": "secondary",
  env: "success",
};

export interface ResolvedConfigField {
  value: unknown;
  source: ConfigFieldSource;
}

interface SchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  format?: string;
  minimum?: number;
  maximum?: number;
  "x-openmapx-secret"?: boolean;
  readOnly?: boolean;
  "x-openmapx-setup"?: CredentialSetup;
}

export interface SchemaConfigField {
  key: string;
  title: string;
  description?: string;
  type: string;
  enum?: string[];
  format?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  setup?: CredentialSetup;
}

function isStructuredField(field: SchemaConfigField): boolean {
  return field.type === "array" || field.type === "object";
}

function toFormValue(field: SchemaConfigField, value: unknown): unknown {
  if (!isStructuredField(field)) return value;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function comparable(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function buildConfigDiff(
  fields: SchemaConfigField[],
  values: Record<string, unknown>,
  changedKeys: string[],
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const key of changedKeys) {
    const field = fields.find((candidate) => candidate.key === key);
    const value = values[key];
    if (
      field?.format &&
      (OPERATOR_STRING_FORMATS as readonly string[]).includes(field.format) &&
      (typeof value !== "string" || !validOperatorString(value, field.format))
    )
      throw Error(`${field.title} has an invalid format`);
    if (field && isStructuredField(field)) {
      try {
        diff[key] = JSON.parse(String(value));
      } catch {
        throw new Error(`${field.title} must be valid JSON`);
      }
    } else {
      diff[key] = value;
    }
  }
  return diff;
}

function humanize(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]/g, " ")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

/**
 * The editable fields of a configSchema. Secrets, read-only state, and any
 * `excludeKeys` (e.g. `enabled`, handled by a dedicated toggle) are dropped, so
 * neither a credential nor an internal state marker renders on the Config tab.
 */
export function extractConfigFields(
  schema: Record<string, unknown> | undefined,
  excludeKeys: readonly string[] = [],
): SchemaConfigField[] {
  if (!schema) return [];
  const props = (schema.properties ?? schema) as Record<string, SchemaProperty>;
  const skip = new Set<string>(["type", "properties", ...excludeKeys]);
  return Object.entries(props)
    .filter(([key, def]) => !skip.has(key) && !def?.["x-openmapx-secret"] && def?.readOnly !== true)
    .map(([key, def]) => ({
      key,
      title: def?.title ?? humanize(key),
      description: def?.description,
      type: def?.type ?? "string",
      enum: def?.enum,
      format: def?.format,
      minimum: def?.minimum,
      maximum: def?.maximum,
      default: def?.default,
      setup: readCredentialSetup(def),
    }));
}

export interface SchemaConfigFormProps {
  /** The manifest `configSchema` object. */
  schema: Record<string, unknown> | undefined;
  /** Resolved per-field values with source annotation. */
  resolvedConfig: Record<string, ResolvedConfigField>;
  /** Keys to omit (e.g. `["enabled"]` when a dedicated toggle owns it). */
  excludeKeys?: readonly string[];
  /** Optional env-var-prefix hint banner (services use `SERVICE_<ID>_<KEY>`). */
  envPrefix?: string;
  ownership?: Record<string, ConfigurationOwnership>;
  /** Persist the changed-keys diff. Throw to surface an inline error. */
  onSave: (diff: Record<string, unknown>) => Promise<void>;
  /** Optional second action that also applies the change. */
  onSaveAndApply?: (diff: Record<string, unknown>) => Promise<void>;
  /** Label for the apply button (default "Save & apply"). */
  applyLabel?: string;
  /** Feature-specific acknowledgement: an accepted job is not completed work. */
  applySuccessMessage?: string;
  /** Preserve edited fields when a background read refreshes the saved baseline. */
  preserveDirtyValuesOnRefresh?: boolean;
  /** Shown when there are no editable (non-secret) fields. */
  emptyMessage?: string;
}

export function SchemaConfigForm({
  schema,
  resolvedConfig,
  excludeKeys,
  envPrefix,
  ownership,
  onSave,
  onSaveAndApply,
  applyLabel = "Save & apply",
  applySuccessMessage = "Configuration saved and applied.",
  preserveDirtyValuesOnRefresh = false,
  emptyMessage = "No editable configuration fields. Credentials live on the Credentials tab.",
}: SchemaConfigFormProps) {
  const fields = useMemo(() => extractConfigFields(schema, excludeKeys), [schema, excludeKeys]);

  // Env-overridden fields are dictated by the host, so they are never seeded
  // into the editable form state — only default/db values are.
  const computeInitialValues = useCallback(() => {
    const initial: Record<string, unknown> = {};
    for (const field of fields) {
      const entry = resolvedConfig[field.key];
      if (
        entry?.source !== "env" &&
        entry?.source !== "config.json" &&
        ownership?.[field.key]?.writable !== false
      ) {
        initial[field.key] = toFormValue(field, entry?.value ?? field.default ?? "");
      }
    }
    return initial;
  }, [fields, resolvedConfig, ownership]);

  const [values, setValues] = useState<Record<string, unknown>>(computeInitialValues);
  const [pending, setPending] = useState<"save" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<"saved" | "applied" | null>(null);

  // A disposed service form's cache refresh may reach its replacement form.
  // Update its saved baseline without overwriting newly edited fields.
  const previousInitial = useRef(values);
  useEffect(() => {
    const next = computeInitialValues();
    const previous = previousInitial.current;
    previousInitial.current = next;
    setValues((current) => {
      if (!preserveDirtyValuesOnRefresh) return next;
      const merged = { ...next };
      for (const key of Object.keys(next)) {
        if (comparable(current[key]) !== comparable(previous[key])) merged[key] = current[key];
      }
      return merged;
    });
  }, [computeInitialValues, preserveDirtyValuesOnRefresh]);

  const originalValues = useMemo(() => {
    const orig: Record<string, unknown> = {};
    for (const field of fields) {
      const entry = resolvedConfig[field.key];
      if (
        entry?.source !== "env" &&
        entry?.source !== "config.json" &&
        ownership?.[field.key]?.writable !== false
      ) {
        orig[field.key] = toFormValue(field, entry?.value ?? field.default ?? "");
      }
    }
    return orig;
  }, [fields, resolvedConfig, ownership]);

  const changedKeys = useMemo(
    () =>
      Object.keys(values).filter(
        (k) =>
          !["env", "config.json"].includes(resolvedConfig[k]?.source ?? "") &&
          ownership?.[k]?.writable !== false &&
          comparable(values[k]) !== comparable(originalValues[k] ?? ""),
      ),
    [values, originalValues, resolvedConfig, ownership],
  );

  const saving = pending !== null;

  async function run(kind: "save" | "apply", fn: (diff: Record<string, unknown>) => Promise<void>) {
    setError(null);
    setSaved(null);
    setPending(kind);
    try {
      const diff = buildConfigDiff(fields, values, changedKeys);
      await fn(diff);
      setSaved(kind === "apply" ? "applied" : "saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setPending(null);
    }
  }

  if (fields.length === 0) {
    return (
      <Alert severity="info" variant="outlined">
        {emptyMessage}
      </Alert>
    );
  }

  return (
    <Stack sx={{ gap: 2.5 }}>
      {error && (
        <Alert severity="error" variant="outlined" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {saved === "saved" && (
        <Alert severity="success" variant="outlined" onClose={() => setSaved(null)}>
          Configuration saved.{onSaveAndApply ? " Use Save & apply to take effect." : ""}
        </Alert>
      )}
      {saved === "applied" && (
        <Alert severity="success" variant="outlined" onClose={() => setSaved(null)}>
          {applySuccessMessage}
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
        const source: ConfigFieldSource = entry?.source ?? "default";
        const isEnvOverridden =
          source === "env" ||
          source === "config.json" ||
          ownership?.[field.key]?.writable === false;
        const displayValue = isEnvOverridden ? toFormValue(field, entry?.value) : values[field.key];

        return (
          <Stack key={field.key} sx={{ gap: 0.5 }}>
            <Stack direction="row" sx={{ alignItems: "center", gap: 1, flexWrap: "wrap" }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
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
                  label={
                    source === "config.json"
                      ? "host file"
                      : source === "env"
                        ? "env override"
                        : "host owned"
                  }
                  size="small"
                  color="success"
                  sx={{ fontSize: "0.7rem" }}
                />
              )}
            </Stack>
            {field.description && (
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {field.description}
              </Typography>
            )}
            {isEnvOverridden && (
              <Typography variant="caption" color="text.secondary">
                {source === "config.json"
                  ? "Controlled by the host config file. Remove the host override, refresh, then save."
                  : `Controlled by the host environment${ownership?.[field.key]?.envVar ? ` (${ownership[field.key].envVar})` : ""}. Remove the override, refresh, then save.`}
              </Typography>
            )}
            {field.setup && <CredentialSetupGuide setup={field.setup} />}
            {field.type === "boolean" ? (
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={
                      typeof displayValue === "string"
                        ? ["true", "1"].includes(displayValue.toLowerCase())
                        : Boolean(displayValue)
                    }
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
            ) : isStructuredField(field) ? (
              <TextField
                size="small"
                value={String(displayValue ?? "")}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                disabled={isEnvOverridden || saving}
                multiline
                minRows={6}
                maxRows={24}
                spellCheck={false}
                helperText="JSON"
                sx={{
                  maxWidth: 760,
                  "& textarea": { fontFamily: "monospace", fontSize: "0.8rem" },
                }}
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
                onChange={(e) => {
                  const raw = e.target.value;
                  setValues((prev) => ({
                    ...prev,
                    [field.key]:
                      field.type === "number" || field.type === "integer"
                        ? raw === ""
                          ? ""
                          : Number(raw)
                        : raw,
                  }));
                }}
                disabled={isEnvOverridden || saving}
                type={
                  !isEnvOverridden && (field.type === "number" || field.type === "integer")
                    ? "number"
                    : field.format === "url"
                      ? "url"
                      : "text"
                }
                slotProps={{
                  htmlInput: {
                    min: field.minimum,
                    max: field.maximum,
                    step: field.type === "integer" ? 1 : "any",
                  },
                }}
                placeholder={field.default !== undefined ? String(field.default) : undefined}
                sx={{ maxWidth: 480 }}
              />
            )}
          </Stack>
        );
      })}

      <Stack direction="row" sx={{ gap: 1 }}>
        <Button
          variant={onSaveAndApply ? "outlined" : "contained"}
          size="small"
          startIcon={pending === "save" ? <CircularProgress size={14} /> : <SaveIcon />}
          onClick={() => run("save", onSave)}
          disabled={saving || changedKeys.length === 0}
        >
          Save{changedKeys.length > 0 ? ` (${changedKeys.length} changed)` : ""}
        </Button>
        {onSaveAndApply && (
          <Button
            variant="contained"
            size="small"
            startIcon={pending === "apply" ? <CircularProgress size={14} /> : <RestartAltIcon />}
            onClick={() => run("apply", onSaveAndApply)}
            disabled={saving || changedKeys.length === 0}
          >
            {applyLabel}
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
