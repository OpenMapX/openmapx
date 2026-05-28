"use client";

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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { useAdminToast } from "../shared/AdminToast";

type ConfigSource = "default" | "database" | "vault" | "config.json" | "env";

const SOURCE_COLOR: Record<ConfigSource, "default" | "primary" | "secondary" | "success" | "info"> =
  {
    default: "default",
    database: "primary",
    vault: "info",
    "config.json": "secondary",
    env: "success",
  };

interface SchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  format?: string;
  "x-openmapx-secret"?: boolean;
}

interface ConfigSchemaFormProps {
  integrationId: string;
  /** The manifest configSchema object */
  schema: Record<string, unknown> | undefined;
  /** Resolved config values with source annotations */
  resolvedConfig: Record<string, { value: unknown; source: ConfigSource }>;
  /** Called after a successful save + reload */
  onSaved?: () => void;
}

function humanize(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]/g, " ")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

export function ConfigSchemaForm({
  integrationId,
  schema,
  resolvedConfig,
  onSaved,
}: ConfigSchemaFormProps) {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  const qc = useQueryClient();
  const showToast = useAdminToast();

  // Extract editable fields (non-secret, non-enabled)
  const fields = useMemo(() => {
    if (!schema) return [];
    const props = (schema.properties ?? schema) as Record<string, SchemaProperty>;
    return Object.entries(props)
      .filter(([key, def]) => {
        if (key === "type" || key === "properties") return false;
        if (key === "enabled") return false; // handled by dedicated toggle
        if (def?.["x-openmapx-secret"]) return false;
        return true;
      })
      .map(([key, def]) => ({
        key,
        title: def?.title ?? humanize(key),
        description: def?.description,
        type: def?.type ?? "string",
        enum: def?.enum,
        format: def?.format,
        default: def?.default,
      }));
  }, [schema]);

  // Compute initial form values from resolvedConfig (env-overridden fields excluded)
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

  // Re-sync form state when resolvedConfig changes (e.g. after save + refetch)
  useEffect(() => {
    setValues(computeInitialValues());
  }, [computeInitialValues]);

  // Track original DB values to compute diff
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

  const saveMutation = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      const res = await fetch(`${apiUrl}/api/admin/integrations/${integrationId}/config`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          (err as { error?: string; errors?: string[] })?.errors?.join(", ") ??
            (err as { error?: string })?.error ??
            "Save failed",
        );
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "integrations", integrationId] });
      showToast("Configuration saved");
      onSaved?.();
    },
    onError: (err) => showToast(err instanceof Error ? err.message : "Save failed", "error"),
  });

  function handleSave() {
    const diff: Record<string, unknown> = {};
    for (const key of changedKeys) {
      diff[key] = values[key];
    }
    saveMutation.mutate(diff);
  }

  if (fields.length === 0) {
    return (
      <Alert severity="info" variant="outlined">
        No editable configuration fields. Only secrets and the enabled toggle are available for this
        integration.
      </Alert>
    );
  }

  return (
    <Stack
      sx={{
        gap: 2.5,
      }}
    >
      {fields.map((field) => {
        const entry = resolvedConfig[field.key];
        const source: ConfigSource = entry?.source ?? "default";
        const isEnvOverridden = source === "env";

        return (
          <Stack
            key={field.key}
            sx={{
              gap: 0.5,
            }}
          >
            <Stack
              direction="row"
              sx={{
                alignItems: "center",
                gap: 1,
                flexWrap: "wrap",
              }}
            >
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                }}
              >
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
              {entry?.value === field.default && source === "default" && (
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.disabled",
                  }}
                >
                  (default)
                </Typography>
              )}
            </Stack>
            {field.description && (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
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
                    disabled={isEnvOverridden || saveMutation.isPending}
                  />
                }
                label={
                  <Typography variant="body2" color={isEnvOverridden ? "text.disabled" : undefined}>
                    {String(values[field.key] ?? false)}
                  </Typography>
                }
              />
            ) : field.enum ? (
              <Select
                size="small"
                value={String(values[field.key] ?? "")}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                disabled={isEnvOverridden || saveMutation.isPending}
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
                disabled={isEnvOverridden || saveMutation.isPending}
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
      <Box>
        <Button
          variant="contained"
          size="small"
          startIcon={saveMutation.isPending ? <CircularProgress size={14} /> : <SaveIcon />}
          onClick={handleSave}
          disabled={saveMutation.isPending || changedKeys.length === 0}
        >
          Save{changedKeys.length > 0 ? ` (${changedKeys.length} changed)` : ""}
        </Button>
      </Box>
    </Stack>
  );
}
