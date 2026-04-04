"use client";

import DownloadIcon from "@mui/icons-material/Download";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import MailOutlineIcon from "@mui/icons-material/MailOutline";
import SaveIcon from "@mui/icons-material/Save";
import UploadIcon from "@mui/icons-material/Upload";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormHelperText from "@mui/material/FormHelperText";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";

interface ResolvedSetting {
  group: string;
  key: string;
  label: string;
  description?: string;
  type: string;
  options?: string[];
  secret: boolean;
  value: unknown;
  source: "default" | "database" | "env";
  envVar?: string;
  envOverride: boolean;
}

interface SettingsGroup {
  id: string;
  label: string;
  settings: ResolvedSetting[];
}

function EnvOverrideBadge({ envVar }: { envVar: string }) {
  return (
    <Tooltip
      title={`Overridden by environment variable ${envVar}. Change the env var to update this value.`}
    >
      <Chip
        icon={<WarningAmberIcon sx={{ fontSize: "12px !important" }} />}
        label={envVar}
        size="small"
        color="warning"
        variant="outlined"
        sx={{ fontFamily: "monospace", fontSize: 11, height: 22 }}
      />
    </Tooltip>
  );
}

function SettingField({
  setting,
  value,
  onChange,
}: {
  setting: ResolvedSetting;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const [showSecret, setShowSecret] = useState(false);
  const disabled = setting.envOverride;

  if (setting.type === "boolean") {
    return (
      <FormControlLabel
        control={
          <Switch
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
            size="small"
          />
        }
        label={setting.label}
      />
    );
  }

  if (setting.type === "select" && setting.options) {
    return (
      <FormControl size="small" sx={{ minWidth: 200 }} disabled={disabled}>
        <InputLabel>{setting.label}</InputLabel>
        <Select
          value={String(value ?? "")}
          label={setting.label}
          onChange={(e) => onChange(e.target.value)}
        >
          {setting.options.map((opt) => (
            <MenuItem key={opt} value={opt}>
              {opt}
            </MenuItem>
          ))}
        </Select>
        {setting.description && <FormHelperText>{setting.description}</FormHelperText>}
      </FormControl>
    );
  }

  if (setting.type === "object") {
    const obj = (value && typeof value === "object" ? value : setting.value) as Record<
      string,
      unknown
    >;
    return (
      <Stack gap={1}>
        <Typography variant="caption" color="text.secondary" fontWeight={500}>
          {setting.label}
        </Typography>
        <Stack direction="row" gap={1} flexWrap="wrap">
          {Object.entries(obj).map(([k, v]) => (
            <TextField
              key={k}
              label={k}
              size="small"
              type="number"
              value={v ?? ""}
              disabled={disabled}
              sx={{ width: 120 }}
              onChange={(e) => {
                const updated = { ...obj, [k]: Number(e.target.value) };
                onChange(updated);
              }}
            />
          ))}
        </Stack>
        {setting.description && <FormHelperText>{setting.description}</FormHelperText>}
      </Stack>
    );
  }

  return (
    <TextField
      label={setting.label}
      size="small"
      type={
        setting.secret && !showSecret ? "password" : setting.type === "number" ? "number" : "text"
      }
      value={
        disabled
          ? setting.envOverride
            ? "(set by environment variable)"
            : String(value ?? "")
          : String(value ?? "")
      }
      disabled={disabled}
      helperText={setting.description}
      onChange={(e) =>
        onChange(setting.type === "number" ? Number(e.target.value) : e.target.value)
      }
      slotProps={{
        input:
          setting.secret && !disabled
            ? {
                endAdornment: (
                  <Button
                    size="small"
                    sx={{ fontSize: 11, minWidth: "auto", px: 1 }}
                    onClick={() => setShowSecret((v) => !v)}
                  >
                    {showSecret ? "Hide" : "Show"}
                  </Button>
                ),
              }
            : undefined,
      }}
      sx={{ minWidth: { xs: "100%", sm: 320 } }}
    />
  );
}

function SettingsGroupPanel({
  group,
  onSaved,
  extra,
}: {
  group: SettingsGroup;
  onSaved: (msg: string) => void;
  extra?: ReactNode;
}) {
  const env = useEnv();
  const qc = useQueryClient();
  const computeLocalValues = useCallback(
    () => Object.fromEntries(group.settings.map((s) => [s.key, s.value])),
    [group.settings],
  );
  const [localValues, setLocalValues] = useState<Record<string, unknown>>(computeLocalValues);

  // Re-sync local state when settings are refetched (e.g. after save)
  useEffect(() => {
    setLocalValues(computeLocalValues());
  }, [computeLocalValues]);

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      for (const s of group.settings) {
        if (!s.envOverride) body[s.key] = localValues[s.key];
      }
      const res = await fetch(`${env.apiUrl}/api/admin/settings`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to save settings");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "settings"] });
      onSaved(`${group.label} settings saved`);
    },
  });

  const hasEnvOverrides = group.settings.some((s) => s.envOverride);

  return (
    <Accordion defaultExpanded={group.id === "general"} variant="outlined" disableGutters>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" alignItems="center" gap={1}>
          <Typography fontWeight={600}>{group.label}</Typography>
          {hasEnvOverrides && (
            <Chip
              label="env overrides"
              size="small"
              color="warning"
              variant="outlined"
              sx={{ height: 20, fontSize: 11 }}
            />
          )}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack gap={2.5}>
          {group.settings.map((s) => (
            <Stack key={s.key} gap={0.5}>
              <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                <SettingField
                  setting={s}
                  value={localValues[s.key]}
                  onChange={(v) => setLocalValues((prev) => ({ ...prev, [s.key]: v }))}
                />
                {s.envOverride && s.envVar && <EnvOverrideBadge envVar={s.envVar} />}
              </Stack>
              {s.source === "database" && !s.envOverride && (
                <Typography variant="caption" color="text.secondary" sx={{ pl: 0.5 }}>
                  Source: database
                </Typography>
              )}
            </Stack>
          ))}

          <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
            <Button
              variant="contained"
              size="small"
              startIcon={
                save.isPending ? <CircularProgress size={14} color="inherit" /> : <SaveIcon />
              }
              onClick={() => save.mutate()}
              disabled={save.isPending || group.settings.every((s) => s.envOverride)}
            >
              Save {group.label}
            </Button>
            {extra}
            {save.isError && (
              <Typography variant="caption" color="error">
                Failed to save
              </Typography>
            )}
          </Stack>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

function ExportImportSection({
  onMsg,
}: {
  onMsg: (msg: string, sev?: "success" | "error") => void;
}) {
  const env = useEnv();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const doExport = async () => {
    try {
      const res = await fetch(`${env.apiUrl}/api/admin/settings/export`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `openmapx-settings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      onMsg("Settings exported");
    } catch {
      onMsg("Export failed", "error");
    }
  };

  const doImport = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { settings?: Record<string, unknown> };
      const settings = parsed.settings ?? parsed;
      const res = await fetch(`${env.apiUrl}/api/admin/settings/import`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { imported: number };
      qc.invalidateQueries({ queryKey: ["admin", "settings"] });
      onMsg(`Imported ${data.imported} setting(s)`);
    } catch {
      onMsg("Import failed — check the file format", "error");
    }
  };

  const exportIntegrations = async () => {
    try {
      const res = await fetch(`${env.apiUrl}/api/admin/integrations/export`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `openmapx-integrations-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      onMsg(`Exported ${(data as { count: number }).count} integration configs`);
    } catch {
      onMsg("Export failed", "error");
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>
        Export / Import
      </Typography>
      <Typography variant="body2" color="text.secondary" mb={2}>
        Export settings as JSON for backup or migration. Secrets and env-overridden values are
        excluded.
      </Typography>
      <Stack direction="row" gap={1} flexWrap="wrap">
        <Button variant="outlined" startIcon={<DownloadIcon />} size="small" onClick={doExport}>
          Export Settings
        </Button>
        <Button
          variant="outlined"
          startIcon={<UploadIcon />}
          size="small"
          onClick={() => fileRef.current?.click()}
        >
          Import Settings
        </Button>
        <Divider orientation="vertical" flexItem />
        <Button
          variant="outlined"
          startIcon={<DownloadIcon />}
          size="small"
          onClick={exportIntegrations}
        >
          Export Integration Configs
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) doImport(f);
            e.target.value = "";
          }}
        />
      </Stack>
    </Paper>
  );
}

function TestEmailSection({ onMsg }: { onMsg: (msg: string, sev?: "success" | "error") => void }) {
  const env = useEnv();
  const send = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${env.apiUrl}/api/admin/settings/test-email`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = (await res.json()) as { error: string };
        throw new Error(err.error ?? "Test failed");
      }
      return res.json();
    },
    onSuccess: (data: { message: string }) => onMsg(data.message ?? "Test email sent"),
    onError: (err: Error) => onMsg(err.message, "error"),
  });

  return (
    <Button
      variant="outlined"
      size="small"
      startIcon={send.isPending ? <CircularProgress size={14} /> : <MailOutlineIcon />}
      onClick={() => send.mutate()}
      disabled={send.isPending}
    >
      Send Test Email
    </Button>
  );
}

export function SystemSettings() {
  const env = useEnv();
  const [toast, setToast] = useState<{ msg: string; sev: "success" | "error" } | null>(null);

  const { data, isLoading } = useQuery<{ groups: SettingsGroup[] }>({
    queryKey: ["admin", "settings"],
    queryFn: async () => {
      const res = await fetch(`${env.apiUrl}/api/admin/settings`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load settings");
      return res.json();
    },
  });

  const showToast = (msg: string, sev: "success" | "error" = "success") => setToast({ msg, sev });

  if (isLoading) {
    return (
      <Stack gap={2}>
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} variant="rounded" height={56} />
        ))}
      </Stack>
    );
  }

  if (!data) {
    return <Alert severity="error">Failed to load settings</Alert>;
  }

  return (
    <Stack gap={2}>
      <Typography variant="h5" fontWeight={700}>
        Settings
      </Typography>

      {data.groups.map((group) => (
        <SettingsGroupPanel
          key={group.id}
          group={group}
          onSaved={showToast}
          extra={group.id === "email" ? <TestEmailSection onMsg={showToast} /> : undefined}
        />
      ))}

      <ExportImportSection onMsg={showToast} />

      <Snackbar
        open={!!toast}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          severity={toast?.sev ?? "success"}
          onClose={() => setToast(null)}
          variant="filled"
          sx={{ width: "100%" }}
        >
          {toast?.msg}
        </Alert>
      </Snackbar>
    </Stack>
  );
}
