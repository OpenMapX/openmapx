"use client";

import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import MailOutlineIcon from "@mui/icons-material/MailOutlined";
import SaveIcon from "@mui/icons-material/Save";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormHelperText from "@mui/material/FormHelperText";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import {
  getAdminSettings,
  sendAdminTestEmail,
  unwrapAdminResponse,
  updateAdminSettings,
} from "@openmapx/core/api-admin-sdk";
import type { AdminSetting, AdminSettingsGroup } from "@openmapx/core/api-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AdminDraftContext } from "@/lib/admin/AdminDraftProvider";
import { useAdminDraft } from "@/lib/admin/useAdminDraft";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { useActivityClient } from "../activity/activityQueries";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AuthPolicySettings } from "./AuthPolicySettings";
import { ConfigurationMigrationPanel } from "./ConfigurationMigrationPanel";
import {
  configuredEmailProvider,
  EMAIL_PROVIDER_NAMES,
  EmailSettingsSection,
  savedEmailProvider,
} from "./EmailSettingsSection";

export type ResolvedSetting = AdminSetting;

function isVisible(setting: ResolvedSetting, values: Record<string, unknown>): boolean {
  const cond = setting.showWhen;
  if (!cond) return true;
  const current = values[cond.key];
  return Array.isArray(cond.equals)
    ? cond.equals.some((value) => value === current)
    : current === cond.equals;
}

type SettingsGroup = AdminSettingsGroup;
type SettingsUpdate = Parameters<typeof updateAdminSettings>[0];

interface SettingsSection {
  subgroup?: string;
  settings: ResolvedSetting[];
}

export interface SettingsEditorSection {
  id: string;
  groupId: string;
  settingKeys?: readonly string[];
  subgroupIds?: readonly string[];
  label: string;
  description?: string;
  defaultExpanded?: boolean;
  includeTestEmail?: boolean;
}

export interface SettingsEditorText {
  envOverrides: string;
  envOverrideHelp: (envVar: string) => string;
  envSecretValue: string;
  unreadableSecret: string;
  showSecret: string;
  hideSecret: string;
  databaseSource: string;
  save: (label: string) => string;
  saved: (label: string) => string;
  saveFailed: string;
  invalidJson: string;
  sendTestEmail: string;
  testEmailSent: string;
  testEmailFailed: string;
  loadFailed: string;
}

/** The settings editor's own wording, for pages that do not pass theirs. */
function useDefaultEditorText(): SettingsEditorText {
  const t = useTranslations("adminSettings");
  return useMemo(
    () => ({
      envOverrides: t("editor.envOverrides"),
      envOverrideHelp: (envVar) => t("editor.envOverrideHelp", { envVar }),
      envSecretValue: t("editor.envSecretValue"),
      unreadableSecret: t("editor.unreadableSecret"),
      showSecret: t("editor.showSecret"),
      hideSecret: t("editor.hideSecret"),
      databaseSource: t("editor.databaseSource"),
      save: (label) => t("editor.save", { label }),
      saved: (label) => t("editor.saved", { label }),
      saveFailed: t("editor.saveFailed"),
      invalidJson: t("editor.invalidJson"),
      sendTestEmail: t("editor.sendTestEmail"),
      testEmailSent: t("editor.testEmailSent"),
      testEmailFailed: t("editor.testEmailFailed"),
      loadFailed: t("editor.loadFailed"),
    }),
    [t],
  );
}

// Subgroup display metadata. Keys must match the `subgroup` field on the
// matching SettingDef in apps/api/src/routes/admin-settings.ts.
const SUBGROUP_IDS = ["common", "emaillabs", "lettermint", "smtp"] as const;
function useDefaultSubgroupMeta(): Record<string, { label: string; description?: string }> {
  const t = useTranslations("adminSettings");
  return useMemo(
    () =>
      Object.fromEntries(
        SUBGROUP_IDS.map((id) => [
          id,
          { label: t(`subgroups.${id}.label`), description: t(`subgroups.${id}.description`) },
        ]),
      ),
    [t],
  );
}

function groupBySubgroup(settings: ResolvedSetting[]): SettingsSection[] {
  const sections: SettingsSection[] = [];
  for (const s of settings) {
    const last = sections[sections.length - 1];
    if (last && last.subgroup === s.subgroup) {
      last.settings.push(s);
    } else {
      sections.push({ subgroup: s.subgroup, settings: [s] });
    }
  }
  return sections;
}

function EnvOverrideBadge({ envVar, text }: { envVar: string; text: SettingsEditorText }) {
  return (
    <Tooltip title={text.envOverrideHelp(envVar)}>
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
  onValidityChange,
  text,
}: {
  setting: ResolvedSetting;
  value: unknown;
  onChange: (v: unknown) => void;
  onValidityChange: (valid: boolean) => void;
  text: SettingsEditorText;
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
      <FormControl size="small" sx={{ width: "100%", maxWidth: 420 }} disabled={disabled}>
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

  if (
    setting.type === "object" &&
    !Array.isArray(value) &&
    value !== null &&
    typeof value === "object" &&
    Object.values(value).every((entry) => typeof entry === "number")
  ) {
    const obj = (value && typeof value === "object" ? value : setting.value) as Record<
      string,
      unknown
    >;
    return (
      <Stack
        sx={{
          gap: 1,
          width: "100%",
          maxWidth: 520,
        }}
      >
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            fontWeight: 500,
          }}
        >
          {setting.label}
        </Typography>
        <Stack
          direction="row"
          sx={{
            gap: 1,
            flexWrap: "wrap",
          }}
        >
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

  if (setting.type === "object") {
    return (
      <JsonSettingField
        setting={setting}
        value={value}
        disabled={disabled}
        onChange={onChange}
        onValidityChange={onValidityChange}
        invalidJson={text.invalidJson}
      />
    );
  }

  // Secrets resolved from an env var are redacted server-side ("***") and must
  // never be displayed — show a readable note instead of masked dots. Every
  // other field (including non-secret env overrides) shows its real value so
  // the operator can see what's actually in effect.
  const isEnvSecret = setting.envOverride && setting.secret;
  // A stored secret the current key cannot open, until a replacement is typed.
  const isUnreadableSecret = setting.unreadable === true && value === setting.value;
  const displayValue = isEnvSecret ? text.envSecretValue : String(value ?? "");
  const inputType = isEnvSecret
    ? "text"
    : setting.secret && !showSecret
      ? "password"
      : setting.type === "number"
        ? "number"
        : "text";

  return (
    <TextField
      label={setting.label}
      size="small"
      type={inputType}
      value={displayValue}
      disabled={disabled}
      error={isUnreadableSecret}
      helperText={isUnreadableSecret ? text.unreadableSecret : setting.description}
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
                    {showSecret ? text.hideSecret : text.showSecret}
                  </Button>
                ),
              }
            : undefined,
      }}
      sx={{ width: "100%", maxWidth: 420 }}
    />
  );
}

function JsonSettingField({
  setting,
  value,
  disabled,
  onChange,
  onValidityChange,
  invalidJson,
}: {
  setting: ResolvedSetting;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
  onValidityChange: (valid: boolean) => void;
  invalidJson: string;
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [invalid, setInvalid] = useState(false);
  const serialized = JSON.stringify(value ?? null);
  const previousValue = useRef(serialized);
  useEffect(() => {
    if (previousValue.current === serialized) return;
    previousValue.current = serialized;
    setDraft((current) => {
      try {
        if (JSON.stringify(JSON.parse(current)) === serialized) return current;
      } catch {
        /* New server values replace an invalid clean baseline. */
      }
      return JSON.stringify(JSON.parse(serialized), null, 2);
    });
    setInvalid(false);
    onValidityChange(true);
  }, [serialized, onValidityChange]);

  return (
    <TextField
      label={setting.label}
      value={draft}
      disabled={disabled}
      multiline
      minRows={5}
      error={invalid}
      helperText={invalid ? invalidJson : setting.description}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        try {
          const parsed = JSON.parse(next) as unknown;
          setInvalid(false);
          onValidityChange(true);
          onChange(parsed);
        } catch {
          setInvalid(true);
          onValidityChange(false);
        }
      }}
      slotProps={{ htmlInput: { spellCheck: false } }}
      sx={{ width: "100%", maxWidth: 640, "& textarea": { fontFamily: "monospace" } }}
    />
  );
}

function SettingsGroupPanel({
  group,
  draft,
  onSaved,
  extra,
  description,
  anchorId,
  defaultExpanded,
  focusKey,
  flat = false,
  subgroupMeta: subgroupMetaProp,
  text,
}: {
  group: SettingsGroup;
  draft: ReturnType<typeof useAdminDraft>;
  onSaved: (msg: string) => void;
  extra?: ReactNode;
  description?: string;
  anchorId?: string;
  defaultExpanded?: boolean;
  focusKey?: string;
  flat?: boolean;
  subgroupMeta?: Record<string, { label: string; description?: string }>;
  text: SettingsEditorText;
}) {
  const t = useTranslations("adminSettings");
  const tShared = useTranslations("adminShared");
  const defaultSubgroupMeta = useDefaultSubgroupMeta();
  const subgroupMeta = subgroupMetaProp ?? defaultSubgroupMeta;
  const { apiUrl, client } = useActivityClient();
  const owner = useAdminMutationOwner(client, group.id);
  const qc = useQueryClient();
  const serverValues = Object.fromEntries(
    group.settings.map((setting) => [setting.key, setting.value]),
  );
  const [secretValues, setSecretValues] = useState<Record<string, unknown>>({});
  const [invalidKeys, setInvalidKeys] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState(defaultExpanded ?? group.id === "general");
  useEffect(() => {
    if (!focusKey || !group.settings.some((setting) => setting.key === focusKey)) return;
    setExpanded(true);
    const timer = setTimeout(() => {
      const element = document.getElementById(`setting-${focusKey}`);
      element?.scrollIntoView?.({ block: "center" });
      element?.querySelector<HTMLElement>("input, textarea, button, [role=combobox]")?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [focusKey, group.settings]);
  const renderedValues = { ...serverValues, ...draft.values, ...secretValues };
  const dirtyKeys = group.settings
    .filter(
      (setting) =>
        !setting.envOverride &&
        isVisible(setting, renderedValues) &&
        (setting.secret
          ? Object.hasOwn(secretValues, setting.key) && secretValues[setting.key] !== setting.value
          : draft.dirtyKeys.includes(setting.key)),
    )
    .map((setting) => setting.key);
  const conflicts = draft.conflicts.filter((key) =>
    group.settings.some((setting) => setting.key === key && isVisible(setting, renderedValues)),
  );

  const save = useMutation({
    retry: false,
    mutationFn: async () => {
      const acknowledge = draft.acknowledge;
      const execution = owner;
      const executingApiUrl = apiUrl;
      const body: SettingsUpdate = {};
      for (const s of group.settings) {
        if (s.envOverride || !dirtyKeys.includes(s.key)) continue;
        // Keep configured credentials unless the operator replaces or explicitly clears them.
        if (s.secret && renderedValues[s.key] === "***") continue;
        // Don't write fields hidden by their showWhen predicate — saving while
        // a field is hidden would clobber the stored value of the option that
        // isn't currently active.
        if (!isVisible(s, renderedValues)) continue;
        // Form values are JSON scalars or the server's own JSON; the API validates each type.
        body[s.key] = renderedValues[s.key] as SettingsUpdate[string];
      }
      unwrapAdminResponse(await updateAdminSettings(body, { client }));
      acknowledge(
        Object.fromEntries(
          Object.entries(body).filter(([key]) =>
            group.settings.some((setting) => setting.key === key && !setting.secret),
          ),
        ),
      );
      return { body, execution, executingApiUrl };
    },
    onSuccess: ({ body, execution, executingApiUrl }) => {
      void qc.invalidateQueries({ queryKey: ["admin", "settings", executingApiUrl] });
      if (!execution.active) return;
      setSecretValues((current) =>
        Object.fromEntries(Object.entries(current).filter(([key, value]) => body[key] !== value)),
      );
      onSaved(text.saved(group.label));
    },
  });

  const emailGroup = group.settings.some((setting) => setting.group === "email");
  const emailProvider = savedEmailProvider(serverValues);
  const visibleSettings = group.settings.filter((s) => isVisible(s, renderedValues));
  // Reflect only the settings the operator can actually see: a setting hidden
  // by its showWhen predicate (e.g. the MapTiler key while the provider is
  // self-hosted) must not flag the whole panel as env-overridden, or the badge
  // contradicts an otherwise-editable field.
  const hasEnvOverrides = visibleSettings.some((s) => s.envOverride);

  const contents = (
    <>
      {focusKey &&
        group.settings.some(
          (setting) => setting.key === focusKey && !isVisible(setting, renderedValues),
        ) && <Alert severity="info">{t("hiddenSetting")}</Alert>}
      <Stack
        sx={{
          gap: 2.5,
        }}
      >
        {conflicts.length > 0 && (
          <Alert
            severity="warning"
            action={
              <Button
                onClick={() => draft.keepEdits(group.settings.map((setting) => setting.key))}
                disabled={save.isPending}
              >
                {tShared("keepMyEdits")}
              </Button>
            }
          >
            {tShared("savedValuesChangedForConflicts", {
              settingLabels: conflicts
                .map((key) => group.settings.find((setting) => setting.key === key)?.label ?? key)
                .join(", "),
            })}
          </Alert>
        )}
        {emailGroup && (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("savedEmailProvider", { provider: EMAIL_PROVIDER_NAMES[emailProvider] })}
          </Typography>
        )}
        {groupBySubgroup(visibleSettings).map((section) => (
          <EmailSettingsSection
            key={section.subgroup ?? "__"}
            provider={emailGroup ? section.subgroup : undefined}
            label={section.subgroup ? subgroupMeta[section.subgroup]?.label : undefined}
            description={section.subgroup ? subgroupMeta[section.subgroup]?.description : undefined}
            focused={section.settings.some((setting) => setting.key === focusKey)}
            selected={emailGroup && section.subgroup === emailProvider}
            configured={configuredEmailProvider(section.subgroup, serverValues)}
          >
            {(!emailGroup ||
              !["emaillabs", "lettermint", "smtp"].includes(section.subgroup ?? "")) &&
              section.subgroup &&
              subgroupMeta[section.subgroup] && (
                <Stack
                  sx={{
                    gap: 0.25,
                  }}
                >
                  <Typography
                    variant="overline"
                    sx={{
                      color: "text.secondary",
                      lineHeight: 1.2,
                    }}
                  >
                    {subgroupMeta[section.subgroup]?.label}
                  </Typography>
                  {subgroupMeta[section.subgroup]?.description && (
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {subgroupMeta[section.subgroup]?.description}
                    </Typography>
                  )}
                </Stack>
              )}
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(280px, 420px))" },
                gap: 2,
                alignItems: "start",
              }}
            >
              {section.settings.map((s) => (
                <Stack
                  id={`setting-${s.key}`}
                  key={s.key}
                  sx={{ gap: 0.5, minWidth: 0, scrollMarginTop: 80 }}
                >
                  <Stack
                    direction="row"
                    sx={{
                      alignItems: "center",
                      gap: 1,
                      flexWrap: "wrap",
                    }}
                  >
                    <SettingField
                      key={s.key}
                      setting={s}
                      value={renderedValues[s.key]}
                      onChange={(v) =>
                        s.secret
                          ? setSecretValues((previous) => ({ ...previous, [s.key]: v }))
                          : draft.setValues((previous) => ({ ...previous, [s.key]: v }))
                      }
                      onValidityChange={(valid) =>
                        setInvalidKeys((current) => {
                          const next = new Set(current);
                          if (valid) next.delete(s.key);
                          else next.add(s.key);
                          return next;
                        })
                      }
                      text={text}
                    />
                    {s.envOverride && s.envVar && (
                      <EnvOverrideBadge envVar={s.envVar} text={text} />
                    )}
                  </Stack>
                  {s.source === "database" && !s.envOverride && (
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                        pl: 0.5,
                      }}
                    >
                      {text.databaseSource}
                    </Typography>
                  )}
                </Stack>
              ))}
            </Box>
          </EmailSettingsSection>
        ))}

        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            gap: 1,
            flexWrap: "wrap",
          }}
        >
          <Button
            variant="contained"
            size="small"
            startIcon={
              save.isPending ? <CircularProgress size={14} color="inherit" /> : <SaveIcon />
            }
            onClick={() => save.mutate()}
            disabled={
              save.isPending ||
              dirtyKeys.length === 0 ||
              conflicts.length > 0 ||
              invalidKeys.size > 0 ||
              visibleSettings.every((s) => s.envOverride)
            }
          >
            {text.save(group.label)}
          </Button>
          {dirtyKeys.length > 0 && (
            <Button
              size="small"
              disabled={save.isPending}
              onClick={() => {
                draft.discard(group.settings.map((setting) => setting.key));
                setSecretValues({});
                setInvalidKeys(new Set());
              }}
            >
              {tShared("discard")}
            </Button>
          )}
          {extra}
          {save.isError && (
            <Typography variant="caption" color="error">
              {text.saveFailed}
            </Typography>
          )}
        </Stack>
      </Stack>
    </>
  );
  if (flat)
    return (
      <Box component="section" id={anchorId} sx={{ maxWidth: 760 }}>
        {contents}
      </Box>
    );
  return (
    <Accordion
      id={anchorId}
      expanded={expanded}
      onChange={(_event, value) => setExpanded(value)}
      variant="outlined"
      disableGutters
      sx={{
        "&.MuiAccordion-rounded": {
          borderRadius: 2,
          overflow: "hidden",
          "&:first-of-type, &:last-of-type": { borderRadius: 2 },
        },
      }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 48 }}>
        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            gap: 1,
          }}
        >
          <Stack sx={{ gap: 0.25 }}>
            <Typography sx={{ fontWeight: 600 }}>{group.label}</Typography>
            {description && (
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {description}
              </Typography>
            )}
          </Stack>
          {hasEnvOverrides && (
            <Chip
              label={text.envOverrides}
              size="small"
              color="warning"
              variant="outlined"
              sx={{ height: 20, fontSize: 11 }}
            />
          )}
        </Stack>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 2, pt: 1.5, pb: 2, borderTop: 1, borderColor: "divider" }}>
        {contents}
      </AccordionDetails>
    </Accordion>
  );
}

function TestEmailSection({
  onMsg,
  text,
}: {
  onMsg: (msg: string, sev?: "success" | "error") => void;
  text: SettingsEditorText;
}) {
  const { client } = useActivityClient();
  const send = useMutation({
    mutationFn: async () => unwrapAdminResponse(await sendAdminTestEmail({ client })),
    onSuccess: () => onMsg(text.testEmailSent),
    onError: () => onMsg(text.testEmailFailed, "error"),
  });

  return (
    <Button
      variant="outlined"
      size="small"
      startIcon={send.isPending ? <CircularProgress size={14} /> : <MailOutlineIcon />}
      onClick={() => send.mutate()}
      disabled={send.isPending}
    >
      {text.sendTestEmail}
    </Button>
  );
}

export function SystemSettings({
  sections,
  showHeader = true,
  showTransfer = true,
  settingText,
  subgroupMeta,
  text: textProp,
  onSettingsSaved,
  focusKey,
  flatSections = false,
}: {
  sections?: readonly SettingsEditorSection[];
  showHeader?: boolean;
  showTransfer?: boolean;
  settingText?: (setting: ResolvedSetting) => Pick<ResolvedSetting, "label" | "description">;
  subgroupMeta?: Record<string, { label: string; description?: string }>;
  text?: SettingsEditorText;
  onSettingsSaved?: () => void | Promise<void>;
  focusKey?: string;
  flatSections?: boolean;
} = {}) {
  const t = useTranslations("adminSettings");
  const defaultText = useDefaultEditorText();
  const text = textProp ?? defaultText;
  const { apiUrl, client } = useActivityClient();
  const draftStore = useContext(AdminDraftContext);
  const [toast, setToast] = useState<{ msg: string; sev: "success" | "error" } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "settings", apiUrl, draftStore?.scopeKey ?? "isolated"],
    enabled: !draftStore || draftStore.scopeKey !== null,
    queryFn: async ({ signal }) => unwrapAdminResponse(await getAdminSettings({ client, signal })),
  });

  const ordinarySettings = (data?.groups ?? [])
    .flatMap((group) => group.settings)
    .filter((setting) => !setting.secret && !setting.envOverride && setting.source !== "env");
  const draft = useAdminDraft({
    id: "settings",
    baseline: Object.fromEntries(ordinarySettings.map((setting) => [setting.key, setting.value])),
    editableKeys: ordinarySettings.map((setting) => setting.key),
    signature: "settings-v1",
    ready: !!data,
  });

  const showToast = (msg: string, sev: "success" | "error" = "success") => setToast({ msg, sev });
  const handleSaved = (msg: string) => {
    showToast(msg);
    void onSettingsSaved?.();
  };

  const panels = useMemo(() => {
    if (!data) return [];
    const groups = data.groups
      .map((group) => ({
        ...group,
        settings: group.settings.filter(
          (setting) =>
            ![
              "emailVerificationRequired",
              "sessionDurationHours",
              "twoFaEnabled",
              "passwordMinLength",
            ].includes(setting.key),
        ),
      }))
      .filter((group) => group.settings.length > 0);
    return sections
      ? sections.flatMap((section) => {
          const source = groups.find((group) => group.id === section.groupId);
          if (!source) return [];
          const settings = source.settings
            .filter(
              (setting) =>
                (!section.settingKeys || section.settingKeys.includes(setting.key)) &&
                (!section.subgroupIds ||
                  (setting.subgroup !== undefined &&
                    section.subgroupIds.includes(setting.subgroup))),
            )
            .map((setting) => ({ ...setting, ...(settingText?.(setting) ?? {}) }));
          if (settings.length === 0) return [];
          return [
            { section, group: { ...source, id: section.id, label: section.label, settings } },
          ];
        })
      : groups.map((group) => ({ section: undefined, group }));
  }, [data, sections, settingText]);

  if (isLoading) {
    return (
      <Stack
        sx={{
          gap: 2,
        }}
      >
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} variant="rounded" height={56} />
        ))}
      </Stack>
    );
  }

  if (!data) {
    return draftStore && draftStore.scopeKey === null ? (
      <Alert
        severity="warning"
        action={<Button onClick={() => window.location.reload()}>{t("reload")}</Button>}
      >
        {t("accessChanged")}
      </Alert>
    ) : (
      <Alert severity="error">{text.loadFailed}</Alert>
    );
  }

  return (
    <Stack
      sx={{
        gap: 1.5,
      }}
    >
      {showHeader && <AdminPageHeader title={t("title")} subtitle={t("subtitle")} />}
      {(!sections || sections.some((section) => section.groupId === "auth")) &&
        data.groups.some((group) => group.id === "auth") && (
          <AuthPolicySettings focusKey={focusKey} />
        )}
      {panels.map(({ group, section }) => (
        <SettingsGroupPanel
          key={section?.id ?? group.id}
          group={group}
          draft={draft}
          onSaved={handleSaved}
          anchorId={section?.id}
          description={section?.description}
          defaultExpanded={section?.defaultExpanded}
          focusKey={focusKey}
          flat={flatSections}
          subgroupMeta={subgroupMeta}
          text={text}
          extra={
            section?.includeTestEmail || (!section && group.id === "email") ? (
              <TestEmailSection onMsg={showToast} text={text} />
            ) : undefined
          }
        />
      ))}
      {showTransfer && <ConfigurationMigrationPanel />}
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

/** Transfer utilities intentionally fetch no settings values until an operator exports. */
export function SettingsTransfer() {
  const t = useTranslations("adminSettings");
  return (
    <Stack sx={{ gap: 2, maxWidth: 900 }}>
      <AdminPageHeader title={t("transfer.title")} subtitle={t("transfer.subtitle")} />
      <ConfigurationMigrationPanel />
    </Stack>
  );
}
