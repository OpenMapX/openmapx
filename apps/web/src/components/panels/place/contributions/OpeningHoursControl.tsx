"use client";

import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormLabel from "@mui/material/FormLabel";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import {
  buildSimpleWeekdaySelectors,
  createDefaultOpeningHoursRule,
  extractSimpleWeekdaySelection,
  OSM_MONTHS,
  OSM_SOLAR_EVENTS,
  OSM_WEEKDAYS,
  type OsmDateEndpoint,
  type OsmDateOffset,
  type OsmEditableField,
  type OsmHoliday,
  type OsmMonth,
  type OsmMonthdayRange,
  type OsmNthEntry,
  type OsmNthValue,
  type OsmOpeningHoursDocument,
  type OsmOpeningHoursRule,
  type OsmRuleModifier,
  type OsmRuleSeparator,
  type OsmSolarEvent,
  type OsmTimePoint,
  type OsmTimeSelector,
  type OsmWeekday,
  type OsmWeekdaySelectorItem,
  type OsmWeekRange,
  type OsmYearRange,
  parseOsmOpeningHours,
  serializeOsmOpeningHours,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { OsmContributionEvent, OsmDraft } from "./osmContributionDraft";

const WEEKDAY_LABEL_KEY: Record<OsmWeekday, string> = {
  Mo: "ohDayMo",
  Tu: "ohDayTu",
  We: "ohDayWe",
  Th: "ohDayTh",
  Fr: "ohDayFr",
  Sa: "ohDaySa",
  Su: "ohDaySu",
};

const SOLAR_LABEL_KEY: Record<OsmSolarEvent, string> = {
  dawn: "ohSolarDawn",
  sunrise: "ohSolarSunrise",
  sunset: "ohSolarSunset",
  dusk: "ohSolarDusk",
};

const VALID_NTH_VALUES: readonly OsmNthValue[] = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5];

function withPosition<T>(
  items: readonly T[],
  prefix: string,
): Array<{ item: T; position: number; slotKey: string }> {
  return items.map((item, position) => ({
    item,
    position,
    slotKey: `${prefix}-${position}`,
  }));
}

function formatClockInput(hours: number, minutes: number): string {
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function parseClockInput(
  raw: string,
  allowExtended: boolean,
): { hours: number; minutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  const hRaw = match?.[1];
  const mRaw = match?.[2];
  if (!hRaw || !mRaw) return null;
  const hours = Number.parseInt(hRaw, 10);
  const minutes = Number.parseInt(mRaw, 10);
  const maxHours = allowExtended ? 48 : 24;
  if (minutes > 59 || hours > maxHours || (hours === maxHours && minutes > 0)) {
    return null;
  }
  return { hours, minutes };
}

function formatNthEntries(entries?: OsmNthEntry[]): string {
  if (!entries || entries.length === 0) return "";
  return entries.map((e) => (e.to !== undefined ? `${e.from}-${e.to}` : `${e.from}`)).join(",");
}

function parseNthEntriesInput(raw: string): OsmNthEntry[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(",");
  const result: OsmNthEntry[] = [];
  for (const part of parts) {
    const token = part.trim();
    if (!token) continue;
    const rangeMatch = /^([1-5])-([1-5])$/.exec(token);
    const fromRaw = rangeMatch?.[1];
    const toRaw = rangeMatch?.[2];
    if (fromRaw && toRaw) {
      const from = Number.parseInt(fromRaw, 10) as OsmNthValue;
      const to = Number.parseInt(toRaw, 10) as OsmNthValue;
      if (to >= from) {
        result.push({ from, to });
      }
      continue;
    }
    const singleMatch = /^(-?[1-5])$/.exec(token);
    const singleRaw = singleMatch?.[1];
    if (singleRaw) {
      const val = Number.parseInt(singleRaw, 10) as OsmNthValue;
      if (VALID_NTH_VALUES.includes(val)) {
        result.push({ from: val });
      }
    }
  }
  return result.length > 0 ? result : undefined;
}

interface OpeningHoursControlProps {
  descriptor: Extract<OsmEditableField, { kind: "text" }>;
  draft: OsmDraft;
  disabled: boolean;
  error?: string;
  helperText: string;
  dispatch: (event: OsmContributionEvent) => void;
  removeToggle: React.ReactNode;
}

export function OpeningHoursControl({
  descriptor,
  draft,
  disabled,
  error,
  helperText,
  dispatch,
  removeToggle,
}: OpeningHoursControlProps) {
  const t = useTranslations("osmContributions");
  const operation = draft.operations.openingHours;
  const activeValue = operation?.kind === "set" ? operation.value : (descriptor.currentValue ?? "");

  const [mode, setMode] = useState<"visual" | "raw">("visual");
  const [rawOverride, setRawOverride] = useState<string | null>(null);

  const effectiveString = rawOverride ?? activeValue;
  const parseResult =
    effectiveString.trim() === ""
      ? {
          ok: true as const,
          document: { rules: [createDefaultOpeningHoursRule()] },
          canonical: "Mo-Fr 09:00-17:00",
        }
      : parseOsmOpeningHours(effectiveString);

  function commitDocument(nextDoc: OsmOpeningHoursDocument) {
    setRawOverride(null);
    const serialized = serializeOsmOpeningHours(nextDoc);
    dispatch({
      type: "setText",
      field: "openingHours",
      value: serialized,
    });
  }

  function applyPreset(presetValue: string) {
    setRawOverride(null);
    dispatch({
      type: "setText",
      field: "openingHours",
      value: presetValue,
    });
  }

  function updateRule(index: number, nextRule: OsmOpeningHoursRule) {
    if (!parseResult.ok) return;
    const nextRules = parseResult.document.rules.map((r, i) => (i === index ? nextRule : r));
    commitDocument({ rules: nextRules });
  }

  function removeRule(index: number) {
    if (!parseResult.ok) return;
    const nextRules = parseResult.document.rules.filter((_, i) => i !== index);
    if (nextRules.length === 0) {
      nextRules.push(createDefaultOpeningHoursRule());
    }
    commitDocument({ rules: nextRules });
  }

  function moveRule(index: number, direction: -1 | 1) {
    if (!parseResult.ok) return;
    const target = index + direction;
    const rules = [...parseResult.document.rules];
    const current = rules[index];
    const other = rules[target];
    if (!current || !other) return;
    rules[index] = other;
    rules[target] = current;
    commitDocument({ rules });
  }

  function addRule(rule: OsmOpeningHoursRule) {
    if (!parseResult.ok) return;
    commitDocument({
      rules: [...parseResult.document.rules, rule],
    });
  }

  return (
    <Box>
      <Stack
        direction="row"
        sx={{
          justifyContent: "space-between",
          alignItems: "center",
          mb: 1.5,
          flexWrap: "wrap",
          gap: 1,
        }}
      >
        <FormLabel component="legend" sx={{ fontWeight: 600 }}>
          {descriptor.label}
        </FormLabel>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={mode}
          onChange={(_event, nextMode: "visual" | "raw" | null) => {
            if (nextMode) setMode(nextMode);
          }}
          disabled={disabled}
        >
          <ToggleButton value="visual" sx={{ minHeight: 36, px: 1.5 }}>
            {t("ohModeVisual")}
          </ToggleButton>
          <ToggleButton value="raw" sx={{ minHeight: 36, px: 1.5 }}>
            {t("ohModeRaw")}
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {mode === "raw" ? (
        <TextField
          fullWidth
          size="small"
          label={t("ohRawInputLabel")}
          value={effectiveString}
          disabled={disabled}
          error={Boolean(error) || (effectiveString.trim() !== "" && !parseResult.ok)}
          helperText={helperText}
          slotProps={{ htmlInput: { maxLength: descriptor.maxCodePoints * 2 } }}
          onChange={(event) => {
            const val = event.target.value;
            setRawOverride(val);
            dispatch({ type: "setText", field: "openingHours", value: val });
          }}
        />
      ) : !parseResult.ok ? (
        <Stack spacing={1.5}>
          <Alert severity="warning">
            <Typography variant="body2">{t("ohParseErrorBanner")}</Typography>
            <Typography
              variant="caption"
              sx={{ display: "block", mt: 0.5, fontFamily: "monospace" }}
            >
              {parseResult.error}
            </Typography>
          </Alert>
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="outlined"
              onClick={() => setMode("raw")}
              disabled={disabled}
              sx={{ minHeight: 40 }}
            >
              {t("ohModeRaw")}
            </Button>
            <Button
              size="small"
              onClick={() => applyPreset("Mo-Fr 09:00-17:00")}
              disabled={disabled}
              sx={{ minHeight: 40 }}
            >
              {t("ohPresetWeekdays9To17")}
            </Button>
          </Stack>
        </Stack>
      ) : (
        <Stack spacing={2}>
          {/* Quick Presets */}
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", rowGap: 1 }}>
            <Chip
              label={t("ohPreset24_7")}
              onClick={() => applyPreset("24/7")}
              disabled={disabled}
              variant={effectiveString.trim() === "24/7" ? "filled" : "outlined"}
              color={effectiveString.trim() === "24/7" ? "primary" : "default"}
              sx={{ minHeight: 32 }}
            />
            <Chip
              label={t("ohPresetWeekdays9To17")}
              onClick={() => applyPreset("Mo-Fr 09:00-17:00")}
              disabled={disabled}
              variant={effectiveString.trim() === "Mo-Fr 09:00-17:00" ? "filled" : "outlined"}
              color={effectiveString.trim() === "Mo-Fr 09:00-17:00" ? "primary" : "default"}
              sx={{ minHeight: 32 }}
            />
            <Chip
              label={t("ohPresetMonSat")}
              onClick={() => applyPreset("Mo-Fr 09:00-18:00; Sa 09:00-14:00")}
              disabled={disabled}
              variant={
                effectiveString.trim() === "Mo-Fr 09:00-18:00; Sa 09:00-14:00"
                  ? "filled"
                  : "outlined"
              }
              color={
                effectiveString.trim() === "Mo-Fr 09:00-18:00; Sa 09:00-14:00"
                  ? "primary"
                  : "default"
              }
              sx={{ minHeight: 32 }}
            />
            <Chip
              label={t("ohPresetDaily")}
              onClick={() => applyPreset("Mo-Su 09:00-22:00")}
              disabled={disabled}
              variant={effectiveString.trim() === "Mo-Su 09:00-22:00" ? "filled" : "outlined"}
              color={effectiveString.trim() === "Mo-Su 09:00-22:00" ? "primary" : "default"}
              sx={{ minHeight: 32 }}
            />
          </Stack>

          {/* Rule Cards */}
          {withPosition(parseResult.document.rules, "rule").map(
            ({ item: rule, position: ruleIndex, slotKey }) => (
              <RuleEditorCard
                key={slotKey}
                rule={rule}
                ruleIndex={ruleIndex}
                totalRules={parseResult.document.rules.length}
                disabled={disabled}
                onChange={(nextRule) => updateRule(ruleIndex, nextRule)}
                onRemove={() => removeRule(ruleIndex)}
                onMoveUp={() => moveRule(ruleIndex, -1)}
                onMoveDown={() => moveRule(ruleIndex, 1)}
              />
            ),
          )}

          {/* Add Rule Actions */}
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", rowGap: 1 }}>
            <Button
              size="small"
              variant="outlined"
              disabled={disabled}
              onClick={() => addRule(createDefaultOpeningHoursRule(";"))}
              sx={{ minHeight: 40 }}
            >
              {t("ohAddRule")}
            </Button>
            <Button
              size="small"
              variant="outlined"
              disabled={disabled}
              onClick={() =>
                addRule({
                  separator: ";",
                  is24_7: false,
                  years: [],
                  months: [],
                  weeks: [],
                  weekdays: [{ kind: "holiday", holiday: "PH" }],
                  times: [],
                  modifier: "off",
                })
              }
              sx={{ minHeight: 40 }}
            >
              {t("ohAddHolidayRule")}
            </Button>
            <Button
              size="small"
              variant="outlined"
              disabled={disabled}
              onClick={() => addRule(createDefaultOpeningHoursRule("||"))}
              sx={{ minHeight: 40 }}
            >
              {t("ohAddFallbackRule")}
            </Button>
          </Stack>

          {/* Live OSM Tag Syntax Preview */}
          <Paper variant="outlined" sx={{ p: 1.5, bgcolor: "action.hover" }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              {t("ohLiveSyntaxPreview")}
            </Typography>
            <Typography
              variant="body2"
              data-testid="opening-hours-live-preview"
              sx={{ fontFamily: "monospace", wordBreak: "break-word", mt: 0.25 }}
            >
              {effectiveString.trim() === ""
                ? (descriptor.currentValue ?? t("chooserEmptyValue"))
                : effectiveString}
            </Typography>
            <Typography
              variant="caption"
              color={error ? "error" : "text.secondary"}
              sx={{ display: "block", mt: 0.5 }}
            >
              {helperText}
            </Typography>
          </Paper>
        </Stack>
      )}

      {removeToggle}
    </Box>
  );
}

interface RuleEditorCardProps {
  rule: OsmOpeningHoursRule;
  ruleIndex: number;
  totalRules: number;
  disabled: boolean;
  onChange: (next: OsmOpeningHoursRule) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function RuleEditorCard({
  rule,
  ruleIndex,
  totalRules,
  disabled,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: RuleEditorCardProps) {
  const t = useTranslations("osmContributions");
  const simpleSelection = extractSimpleWeekdaySelection(rule.weekdays);

  const hasAdvancedContent =
    rule.years.length > 0 ||
    rule.months.length > 0 ||
    rule.weeks.length > 0 ||
    rule.rangeComment !== undefined ||
    simpleSelection === null;

  const [advancedExpanded, setAdvancedExpanded] = useState(hasAdvancedContent);

  function toggleWeekday(day: OsmWeekday) {
    const base = simpleSelection ?? {
      weekdays: [],
      includePH: false,
      includeSH: false,
      shAndMode: false,
    };
    const exists = base.weekdays.includes(day);
    const nextWeekdays = exists ? base.weekdays.filter((d) => d !== day) : [...base.weekdays, day];

    onChange({
      ...rule,
      weekdays: buildSimpleWeekdaySelectors({
        ...base,
        weekdays: nextWeekdays,
      }),
    });
  }

  function toggleHoliday(holiday: OsmHoliday) {
    const base = simpleSelection ?? {
      weekdays: [],
      includePH: false,
      includeSH: false,
      shAndMode: false,
    };
    const nextSelection =
      holiday === "PH"
        ? { ...base, includePH: !base.includePH }
        : { ...base, includeSH: !base.includeSH };

    onChange({
      ...rule,
      weekdays: buildSimpleWeekdaySelectors(nextSelection),
    });
  }

  function toggleShAndMode(checked: boolean) {
    if (!simpleSelection) return;
    onChange({
      ...rule,
      weekdays: buildSimpleWeekdaySelectors({
        ...simpleSelection,
        shAndMode: checked,
      }),
    });
  }

  function updateTimeSelector(idx: number, nextTs: OsmTimeSelector) {
    const nextTimes = rule.times.map((ts, i) => (i === idx ? nextTs : ts));
    onChange({ ...rule, times: nextTimes });
  }

  function removeTimeSelector(idx: number) {
    const nextTimes = rule.times.filter((_, i) => i !== idx);
    onChange({ ...rule, times: nextTimes });
  }

  function addTimeSelector() {
    onChange({
      ...rule,
      times: [
        ...rule.times,
        {
          from: { kind: "clock", hours: 9, minutes: 0 },
          to: { kind: "clock", hours: 17, minutes: 0 },
        },
      ],
    });
  }

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        {/* Rule Header */}
        <Stack
          direction="row"
          sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 1 }}
        >
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", flexWrap: "wrap" }}>
            <Typography variant="subtitle2">
              {t("ohRuleLabel", { index: ruleIndex + 1 })}
            </Typography>
            {ruleIndex > 0 && (
              <FormControl size="small" sx={{ minWidth: 180 }}>
                <InputLabel id={`oh-sep-label-${ruleIndex}`}>{t("ohSeparatorLabel")}</InputLabel>
                <Select
                  labelId={`oh-sep-label-${ruleIndex}`}
                  label={t("ohSeparatorLabel")}
                  value={rule.separator}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange({
                      ...rule,
                      separator: e.target.value as OsmRuleSeparator,
                    })
                  }
                >
                  <MenuItem value=";">{t("ohSeparatorNormal")}</MenuItem>
                  <MenuItem value=",">{t("ohSeparatorAdditional")}</MenuItem>
                  <MenuItem value="||">{t("ohSeparatorFallback")}</MenuItem>
                </Select>
              </FormControl>
            )}
          </Stack>

          <Stack direction="row" spacing={0.5}>
            {totalRules > 1 && ruleIndex > 0 && (
              <Button size="small" onClick={onMoveUp} disabled={disabled} sx={{ minHeight: 36 }}>
                ↑
              </Button>
            )}
            {totalRules > 1 && ruleIndex < totalRules - 1 && (
              <Button size="small" onClick={onMoveDown} disabled={disabled} sx={{ minHeight: 36 }}>
                ↓
              </Button>
            )}
            {totalRules > 1 && (
              <Button
                size="small"
                color="error"
                onClick={onRemove}
                disabled={disabled}
                sx={{ minHeight: 36 }}
              >
                {t("ohRemoveRule")}
              </Button>
            )}
          </Stack>
        </Stack>

        {/* 24/7 Switch */}
        <FormControlLabel
          control={
            <Switch
              checked={rule.is24_7}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...rule,
                  is24_7: event.target.checked,
                })
              }
            />
          }
          label={t("ohAlwaysOpen24_7")}
        />

        {!rule.is24_7 && (
          <>
            {/* Days & Holidays Section */}
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
                {t("ohDaysAndHolidays")}
              </Typography>

              {simpleSelection !== null && (
                <Stack spacing={1}>
                  <Stack direction="row" spacing={0.75} sx={{ flexWrap: "wrap", rowGap: 0.75 }}>
                    {OSM_WEEKDAYS.map((day) => {
                      const active = simpleSelection.weekdays.includes(day);
                      return (
                        <Chip
                          key={day}
                          label={t(WEEKDAY_LABEL_KEY[day])}
                          color={active ? "primary" : "default"}
                          variant={active ? "filled" : "outlined"}
                          disabled={disabled}
                          aria-pressed={active}
                          onClick={() => toggleWeekday(day)}
                          sx={{ minHeight: 36 }}
                        />
                      );
                    })}
                  </Stack>

                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ flexWrap: "wrap", rowGap: 0.75, alignItems: "center" }}
                  >
                    <Chip
                      label={t("ohHolidayPH")}
                      color={simpleSelection.includePH ? "primary" : "default"}
                      variant={simpleSelection.includePH ? "filled" : "outlined"}
                      disabled={disabled}
                      aria-pressed={simpleSelection.includePH}
                      onClick={() => toggleHoliday("PH")}
                      sx={{ minHeight: 32 }}
                    />
                    <Chip
                      label={t("ohHolidaySH")}
                      color={simpleSelection.includeSH ? "primary" : "default"}
                      variant={simpleSelection.includeSH ? "filled" : "outlined"}
                      disabled={disabled}
                      aria-pressed={simpleSelection.includeSH}
                      onClick={() => toggleHoliday("SH")}
                      sx={{ minHeight: 32 }}
                    />
                    {simpleSelection.includeSH && simpleSelection.weekdays.length > 0 && (
                      <FormControlLabel
                        control={
                          <Checkbox
                            size="small"
                            checked={simpleSelection.shAndMode}
                            disabled={disabled}
                            onChange={(e) => toggleShAndMode(e.target.checked)}
                          />
                        }
                        label={<Typography variant="caption">{t("ohHolidayShAndMode")}</Typography>}
                      />
                    )}
                  </Stack>
                </Stack>
              )}
            </Box>

            <Divider />

            {/* Time Spans Section */}
            <Box>
              <Stack
                direction="row"
                sx={{ justifyContent: "space-between", alignItems: "center", mb: 1 }}
              >
                <Typography variant="caption" color="text.secondary">
                  {t("ohTimeSpans")}
                </Typography>
                <Button
                  size="small"
                  onClick={addTimeSelector}
                  disabled={disabled}
                  sx={{ minHeight: 36 }}
                >
                  + {t("ohAddTimeSpan")}
                </Button>
              </Stack>

              {rule.times.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  {t("ohAllDay")}
                </Typography>
              ) : (
                <Stack spacing={1.5}>
                  {withPosition(rule.times, "time").map(
                    ({ item: ts, position: tsIdx, slotKey }) => (
                      <TimeSelectorRow
                        key={slotKey}
                        selector={ts}
                        disabled={disabled}
                        onChange={(nextTs) => updateTimeSelector(tsIdx, nextTs)}
                        onRemove={() => removeTimeSelector(tsIdx)}
                      />
                    ),
                  )}
                </Stack>
              )}
            </Box>

            <Divider />
          </>
        )}

        {/* Rule Modifier & Comment */}
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
            {t("ohStateAndComments")}
          </Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
            <FormControl size="small" sx={{ minWidth: 180 }}>
              <InputLabel id={`oh-mod-label-${ruleIndex}`}>{t("ohModifierLabel")}</InputLabel>
              <Select
                labelId={`oh-mod-label-${ruleIndex}`}
                label={t("ohModifierLabel")}
                value={rule.modifier ?? ""}
                disabled={disabled}
                onChange={(e) => {
                  const val = e.target.value as OsmRuleModifier | "";
                  const { modifier: _dropped, ...rest } = rule;
                  onChange(val ? { ...rest, modifier: val } : rest);
                }}
              >
                <MenuItem value="">{t("ohModifierDefault")}</MenuItem>
                <MenuItem value="open">{t("ohModifierOpen")}</MenuItem>
                <MenuItem value="closed">{t("ohModifierClosed")}</MenuItem>
                <MenuItem value="off">{t("ohModifierOff")}</MenuItem>
                <MenuItem value="unknown">{t("ohModifierUnknown")}</MenuItem>
              </Select>
            </FormControl>

            <TextField
              fullWidth
              size="small"
              label={t("ohCommentLabel")}
              value={rule.comment ?? ""}
              disabled={disabled}
              onChange={(e) => {
                const val = e.target.value;
                const { comment: _dropped, ...rest } = rule;
                onChange(val !== "" ? { ...rest, comment: val } : rest);
              }}
            />
          </Stack>
        </Box>

        {/* Advanced Date, Month, Week, Year & Complex Weekday Constraints */}
        {!rule.is24_7 && (
          <Accordion
            disableGutters
            elevation={0}
            expanded={advancedExpanded}
            onChange={(_e, isExpanded) => setAdvancedExpanded(isExpanded)}
            sx={{
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              "&::before": { display: "none" },
            }}
          >
            <AccordionSummary sx={{ minHeight: 44 }}>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                {t("ohAdvancedConstraints")}
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <AdvancedRuleConstraints rule={rule} disabled={disabled} onChange={onChange} />
            </AccordionDetails>
          </Accordion>
        )}
      </Stack>
    </Paper>
  );
}

interface TimeSelectorRowProps {
  selector: OsmTimeSelector;
  disabled: boolean;
  onChange: (next: OsmTimeSelector) => void;
  onRemove: () => void;
}

function TimeSelectorRow({ selector, disabled, onChange, onRemove }: TimeSelectorRowProps) {
  const t = useTranslations("osmContributions");

  const timeKind: "span" | "openEnd" | "point" = selector.to
    ? "span"
    : selector.openEnd
      ? "openEnd"
      : "point";

  function handleTimeKindChange(nextKind: "span" | "openEnd" | "point") {
    if (nextKind === "span") {
      onChange({
        from: selector.from,
        to: selector.to ?? { kind: "clock", hours: 17, minutes: 0 },
      });
    } else if (nextKind === "openEnd") {
      onChange({
        from: selector.from,
        openEnd: true,
      });
    } else {
      onChange({
        from: selector.from,
      });
    }
  }

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack spacing={1.5}>
        <Stack
          direction="row"
          spacing={1}
          sx={{
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            rowGap: 1,
          }}
        >
          <FormControl size="small" sx={{ minWidth: 165 }}>
            <InputLabel>{t("ohTimeKindLabel")}</InputLabel>
            <Select
              label={t("ohTimeKindLabel")}
              value={timeKind}
              disabled={disabled}
              onChange={(e) => handleTimeKindChange(e.target.value as "span" | "openEnd" | "point")}
            >
              <MenuItem value="span">{t("ohTimeKindSpan")}</MenuItem>
              <MenuItem value="openEnd">{t("ohTimeKindOpenEnd")}</MenuItem>
              <MenuItem value="point">{t("ohTimeKindPoint")}</MenuItem>
            </Select>
          </FormControl>

          <Button
            size="small"
            color="error"
            onClick={onRemove}
            disabled={disabled}
            sx={{ minHeight: 36 }}
          >
            {t("ohRemoveTimeSpan")}
          </Button>
        </Stack>

        <Stack
          direction={
            selector.from.kind === "variable" || selector.to?.kind === "variable"
              ? "column"
              : { xs: "column", sm: "row" }
          }
          spacing={1.5}
          sx={{ alignItems: "flex-start" }}
        >
          <TimePointEditor
            label={t("ohStartTime")}
            point={selector.from}
            allowExtended={false}
            disabled={disabled}
            onChange={(nextFrom) => onChange({ ...selector, from: nextFrom })}
          />

          {selector.to && (
            <TimePointEditor
              label={t("ohEndTime")}
              point={selector.to}
              allowExtended={true}
              disabled={disabled}
              onChange={(nextTo) => onChange({ ...selector, to: nextTo })}
            />
          )}
        </Stack>

        {selector.to && (
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1.5}
            sx={{ alignItems: { sm: "center" } }}
          >
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={Boolean(selector.openEnd)}
                  disabled={disabled}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    const { openEnd: _o, intervalMinutes: _i, ...rest } = selector;
                    onChange(checked ? { ...rest, openEnd: true } : rest);
                  }}
                />
              }
              label={<Typography variant="caption">{t("ohOpenEndPlus")}</Typography>}
            />

            {!selector.openEnd && (
              <TextField
                size="small"
                type="number"
                label={t("ohIntervalMinutes")}
                value={selector.intervalMinutes ?? ""}
                disabled={disabled}
                sx={{ maxWidth: 180 }}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const { intervalMinutes: _dropped, ...rest } = selector;
                  if (!raw) {
                    onChange(rest);
                    return;
                  }
                  const num = Number.parseInt(raw, 10);
                  if (Number.isFinite(num) && num >= 1) {
                    onChange({ ...rest, intervalMinutes: num });
                  }
                }}
              />
            )}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

interface TimePointEditorProps {
  label: string;
  point: OsmTimePoint;
  allowExtended: boolean;
  disabled: boolean;
  onChange: (next: OsmTimePoint) => void;
}

function TimePointEditor({
  label,
  point,
  allowExtended,
  disabled,
  onChange,
}: TimePointEditorProps) {
  const t = useTranslations("osmContributions");
  const [clockText, setClockText] = useState<string | null>(null);

  const displayedClock =
    point.kind === "clock" ? (clockText ?? formatClockInput(point.hours, point.minutes)) : "09:00";

  return (
    <Stack spacing={1} sx={{ flex: 1, width: "100%" }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}>
        <FormControl size="small" sx={{ minWidth: 135 }}>
          <InputLabel>{label}</InputLabel>
          <Select
            label={label}
            value={point.kind}
            disabled={disabled}
            onChange={(e) => {
              const nextKind = e.target.value as "clock" | "variable";
              setClockText(null);
              if (nextKind === "clock") {
                onChange({ kind: "clock", hours: 9, minutes: 0 });
              } else {
                onChange({ kind: "variable", event: "sunrise" });
              }
            }}
          >
            <MenuItem value="clock">{t("ohPointTypeClock")}</MenuItem>
            <MenuItem value="variable">{t("ohPointTypeSolar")}</MenuItem>
          </Select>
        </FormControl>

        {point.kind === "clock" ? (
          <TextField
            size="small"
            label={label}
            value={displayedClock}
            disabled={disabled}
            placeholder="09:00"
            sx={{ maxWidth: 120 }}
            onChange={(e) => {
              const raw = e.target.value;
              setClockText(raw);
              const parsed = parseClockInput(raw, allowExtended);
              if (parsed) {
                onChange({
                  kind: "clock",
                  hours: parsed.hours,
                  minutes: parsed.minutes,
                });
              }
            }}
            onBlur={() => setClockText(null)}
          />
        ) : (
          <>
            <FormControl size="small" sx={{ minWidth: 130 }}>
              <InputLabel>{t("ohPointTypeSolar")}</InputLabel>
              <Select
                label={t("ohPointTypeSolar")}
                value={point.event}
                disabled={disabled}
                onChange={(e) =>
                  onChange({
                    ...point,
                    event: e.target.value as OsmSolarEvent,
                  })
                }
              >
                {OSM_SOLAR_EVENTS.map((ev) => (
                  <MenuItem key={ev} value={ev}>
                    {t(SOLAR_LABEL_KEY[ev])}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <TextField
              size="small"
              type="number"
              label={t("ohSolarOffsetMinutes")}
              value={point.offsetMinutes ?? ""}
              disabled={disabled}
              sx={{ maxWidth: 150 }}
              onChange={(e) => {
                const raw = e.target.value.trim();
                const { offsetMinutes: _dropped, ...rest } = point;
                if (!raw || raw === "0") {
                  onChange(rest);
                  return;
                }
                const num = Number.parseInt(raw, 10);
                if (Number.isFinite(num)) {
                  onChange({ ...rest, offsetMinutes: num });
                }
              }}
            />
          </>
        )}
      </Stack>

      {point.kind === "clock" && allowExtended && (
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={point.hours >= 24}
              disabled={disabled}
              onChange={(e) => {
                setClockText(null);
                const nextHours = e.target.checked
                  ? Math.min(48, point.hours + 24)
                  : Math.max(0, point.hours - 24);
                onChange({
                  kind: "clock",
                  hours: nextHours,
                  minutes: point.minutes,
                });
              }}
            />
          }
          label={<Typography variant="caption">{t("ohNextDayHint")}</Typography>}
        />
      )}
    </Stack>
  );
}

interface AdvancedRuleConstraintsProps {
  rule: OsmOpeningHoursRule;
  disabled: boolean;
  onChange: (next: OsmOpeningHoursRule) => void;
}

function AdvancedRuleConstraints({ rule, disabled, onChange }: AdvancedRuleConstraintsProps) {
  const t = useTranslations("osmContributions");

  function updateYear(idx: number, nextYr: OsmYearRange) {
    onChange({
      ...rule,
      years: rule.years.map((y, i) => (i === idx ? nextYr : y)),
    });
  }

  function removeYear(idx: number) {
    onChange({
      ...rule,
      years: rule.years.filter((_, i) => i !== idx),
    });
  }

  function addYear() {
    onChange({
      ...rule,
      years: [...rule.years, { from: 2025 }],
    });
  }

  function updateMonthday(idx: number, nextMd: OsmMonthdayRange) {
    onChange({
      ...rule,
      months: rule.months.map((m, i) => (i === idx ? nextMd : m)),
    });
  }

  function removeMonthday(idx: number) {
    onChange({
      ...rule,
      months: rule.months.filter((_, i) => i !== idx),
    });
  }

  function addMonthRange() {
    onChange({
      ...rule,
      months: [...rule.months, { kind: "months", from: "Apr", to: "Oct" }],
    });
  }

  function addDateRange() {
    onChange({
      ...rule,
      months: [
        ...rule.months,
        {
          kind: "dates",
          from: { kind: "calendar", month: "Dec", day: 24 },
          to: { kind: "calendar", month: "Dec", day: 31 },
        },
      ],
    });
  }

  function updateWeek(idx: number, nextWk: OsmWeekRange) {
    onChange({
      ...rule,
      weeks: rule.weeks.map((w, i) => (i === idx ? nextWk : w)),
    });
  }

  function removeWeek(idx: number) {
    onChange({
      ...rule,
      weeks: rule.weeks.filter((_, i) => i !== idx),
    });
  }

  function addWeek() {
    onChange({
      ...rule,
      weeks: [...rule.weeks, { from: 1, to: 53, step: 2 }],
    });
  }

  function updateWeekdayItem(idx: number, nextItem: OsmWeekdaySelectorItem) {
    onChange({
      ...rule,
      weekdays: rule.weekdays.map((item, i) => (i === idx ? nextItem : item)),
    });
  }

  function removeWeekdayItem(idx: number) {
    onChange({
      ...rule,
      weekdays: rule.weekdays.filter((_, i) => i !== idx),
    });
  }

  function addWeekdayItem() {
    onChange({
      ...rule,
      weekdays: [
        ...rule.weekdays,
        {
          kind: "weekday",
          from: "Mo",
          nth: [{ from: 1 }],
        },
      ],
    });
  }

  return (
    <Stack spacing={2.5}>
      {/* Range Prefix Comment */}
      <TextField
        fullWidth
        size="small"
        label={t("ohRangeCommentLabel")}
        value={rule.rangeComment ?? ""}
        disabled={disabled}
        onChange={(e) => {
          const val = e.target.value;
          const { rangeComment: _dropped, ...rest } = rule;
          onChange(val !== "" ? { ...rest, rangeComment: val } : rest);
        }}
      />

      {/* Year Constraints */}
      <Box>
        <Stack
          direction="row"
          sx={{ justifyContent: "space-between", alignItems: "center", mb: 1 }}
        >
          <Typography variant="caption" color="text.secondary">
            {t("ohYearsTitle")}
          </Typography>
          <Button size="small" onClick={addYear} disabled={disabled} sx={{ minHeight: 36 }}>
            + {t("ohAddYearRange")}
          </Button>
        </Stack>

        <Stack spacing={1}>
          {withPosition(rule.years, "year").map(({ item: yr, position: yrIdx, slotKey }) => (
            <Stack
              key={slotKey}
              direction="row"
              spacing={1}
              sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}
            >
              <TextField
                size="small"
                type="number"
                label={t("ohYearFrom")}
                value={yr.from}
                disabled={disabled}
                sx={{ maxWidth: 110 }}
                onChange={(e) => {
                  const val = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(val) && val > 1900) {
                    updateYear(yrIdx, { ...yr, from: val });
                  }
                }}
              />
              <TextField
                size="small"
                type="number"
                label={t("ohYearTo")}
                value={yr.to ?? ""}
                disabled={disabled || Boolean(yr.openEnd)}
                sx={{ maxWidth: 110 }}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const { to: _dropped, ...rest } = yr;
                  if (!raw) {
                    updateYear(yrIdx, rest);
                    return;
                  }
                  const val = Number.parseInt(raw, 10);
                  if (Number.isFinite(val) && val >= yr.from) {
                    updateYear(yrIdx, { ...rest, to: val });
                  }
                }}
              />
              <TextField
                size="small"
                type="number"
                label={t("ohYearStep")}
                value={yr.step ?? ""}
                disabled={disabled || Boolean(yr.openEnd)}
                sx={{ maxWidth: 100 }}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const { step: _dropped, ...rest } = yr;
                  if (!raw) {
                    updateYear(yrIdx, rest);
                    return;
                  }
                  const val = Number.parseInt(raw, 10);
                  if (Number.isFinite(val) && val >= 1) {
                    updateYear(yrIdx, { ...rest, step: val });
                  }
                }}
              />
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={Boolean(yr.openEnd)}
                    disabled={disabled || yr.to !== undefined}
                    onChange={(e) => {
                      const { openEnd: _dropped, ...rest } = yr;
                      updateYear(yrIdx, e.target.checked ? { ...rest, openEnd: true } : rest);
                    }}
                  />
                }
                label={<Typography variant="caption">{t("ohYearOpenEnd")}</Typography>}
              />
              <Button
                size="small"
                color="error"
                onClick={() => removeYear(yrIdx)}
                disabled={disabled}
                sx={{ minHeight: 36 }}
              >
                {t("ohRemoveYearRange")}
              </Button>
            </Stack>
          ))}
        </Stack>
      </Box>

      <Divider />

      {/* Month & Date Ranges */}
      <Box>
        <Stack
          direction="row"
          sx={{
            justifyContent: "space-between",
            alignItems: "center",
            mb: 1,
            flexWrap: "wrap",
            gap: 1,
          }}
        >
          <Typography variant="caption" color="text.secondary">
            {t("ohMonthsTitle")}
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={addMonthRange} disabled={disabled} sx={{ minHeight: 36 }}>
              + {t("ohAddMonthRange")}
            </Button>
            <Button size="small" onClick={addDateRange} disabled={disabled} sx={{ minHeight: 36 }}>
              + {t("ohAddDateRange")}
            </Button>
          </Stack>
        </Stack>

        <Stack spacing={1.5}>
          {withPosition(rule.months, "month").map(({ item: md, position: mdIdx, slotKey }) => (
            <MonthdayRangeEditor
              key={slotKey}
              range={md}
              disabled={disabled}
              onChange={(nextMd) => updateMonthday(mdIdx, nextMd)}
              onRemove={() => removeMonthday(mdIdx)}
            />
          ))}
        </Stack>
      </Box>

      <Divider />

      {/* ISO Week Ranges */}
      <Box>
        <Stack
          direction="row"
          sx={{ justifyContent: "space-between", alignItems: "center", mb: 1 }}
        >
          <Typography variant="caption" color="text.secondary">
            {t("ohWeeksTitle")}
          </Typography>
          <Button size="small" onClick={addWeek} disabled={disabled} sx={{ minHeight: 36 }}>
            + {t("ohAddWeekRange")}
          </Button>
        </Stack>

        <Stack spacing={1}>
          {withPosition(rule.weeks, "week").map(({ item: wk, position: wkIdx, slotKey }) => (
            <Stack
              key={slotKey}
              direction="row"
              spacing={1}
              sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}
            >
              <TextField
                size="small"
                type="number"
                label={t("ohWeekFrom")}
                value={wk.from}
                disabled={disabled}
                sx={{ maxWidth: 100 }}
                onChange={(e) => {
                  const val = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(val) && val >= 1 && val <= 53) {
                    updateWeek(wkIdx, { ...wk, from: val });
                  }
                }}
              />
              <TextField
                size="small"
                type="number"
                label={t("ohWeekTo")}
                value={wk.to ?? ""}
                disabled={disabled}
                sx={{ maxWidth: 100 }}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const { to: _t, step: _s, ...rest } = wk;
                  if (!raw) {
                    updateWeek(wkIdx, rest);
                    return;
                  }
                  const val = Number.parseInt(raw, 10);
                  if (Number.isFinite(val) && val >= 1 && val <= 53) {
                    updateWeek(wkIdx, { ...wk, to: val });
                  }
                }}
              />
              <TextField
                size="small"
                type="number"
                label={t("ohWeekStep")}
                value={wk.step ?? ""}
                disabled={disabled || wk.to === undefined}
                sx={{ maxWidth: 100 }}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const { step: _dropped, ...rest } = wk;
                  if (!raw) {
                    updateWeek(wkIdx, rest);
                    return;
                  }
                  const val = Number.parseInt(raw, 10);
                  if (Number.isFinite(val) && val >= 1) {
                    updateWeek(wkIdx, { ...rest, step: val });
                  }
                }}
              />
              <Button
                size="small"
                color="error"
                onClick={() => removeWeek(wkIdx)}
                disabled={disabled}
                sx={{ minHeight: 36 }}
              >
                {t("ohRemoveWeekRange")}
              </Button>
            </Stack>
          ))}
        </Stack>
      </Box>

      <Divider />

      {/* Explicit Weekday / Holiday Constraints (Nth occurrences & day offsets) */}
      <Box>
        <Stack
          direction="row"
          sx={{ justifyContent: "space-between", alignItems: "center", mb: 1 }}
        >
          <Typography variant="caption" color="text.secondary">
            {t("ohDaysAndHolidays")}
          </Typography>
          <Button size="small" onClick={addWeekdayItem} disabled={disabled} sx={{ minHeight: 36 }}>
            + {t("ohAddWeekdayItem")}
          </Button>
        </Stack>

        <Stack spacing={1}>
          {withPosition(rule.weekdays, "wday").map(({ item, position: itemIdx, slotKey }) => (
            <WeekdayItemEditor
              key={slotKey}
              item={item}
              disabled={disabled}
              onChange={(nextItem) => updateWeekdayItem(itemIdx, nextItem)}
              onRemove={() => removeWeekdayItem(itemIdx)}
            />
          ))}
        </Stack>
      </Box>
    </Stack>
  );
}

interface MonthdayRangeEditorProps {
  range: OsmMonthdayRange;
  disabled: boolean;
  onChange: (next: OsmMonthdayRange) => void;
  onRemove: () => void;
}

function MonthdayRangeEditor({ range, disabled, onChange, onRemove }: MonthdayRangeEditorProps) {
  const t = useTranslations("osmContributions");

  if (range.kind === "months") {
    return (
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}
        >
          <TextField
            size="small"
            type="number"
            label={t("ohDateYearOptional")}
            value={range.year ?? ""}
            disabled={disabled}
            sx={{ maxWidth: 120 }}
            onChange={(e) => {
              const raw = e.target.value.trim();
              const { year: _dropped, ...rest } = range;
              if (!raw) {
                onChange(rest);
                return;
              }
              const val = Number.parseInt(raw, 10);
              if (Number.isFinite(val) && val > 1900) {
                onChange({ ...rest, year: val });
              }
            }}
          />
          <FormControl size="small" sx={{ minWidth: 110 }}>
            <InputLabel>{t("ohMonthFrom")}</InputLabel>
            <Select
              label={t("ohMonthFrom")}
              value={range.from}
              disabled={disabled}
              onChange={(e) => onChange({ ...range, from: e.target.value as OsmMonth })}
            >
              {OSM_MONTHS.map((m) => (
                <MenuItem key={m} value={m}>
                  {m}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 110 }}>
            <InputLabel>{t("ohMonthTo")}</InputLabel>
            <Select
              label={t("ohMonthTo")}
              value={range.to ?? ""}
              disabled={disabled}
              onChange={(e) => {
                const val = e.target.value as OsmMonth | "";
                const { to: _dropped, ...rest } = range;
                onChange(val ? { ...rest, to: val } : rest);
              }}
            >
              <MenuItem value="">{t("ohWeekdayNone")}</MenuItem>
              {OSM_MONTHS.map((m) => (
                <MenuItem key={m} value={m}>
                  {m}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button
            size="small"
            color="error"
            onClick={onRemove}
            disabled={disabled}
            sx={{ minHeight: 36 }}
          >
            {t("ohRemoveMonthdayRange")}
          </Button>
        </Stack>
      </Paper>
    );
  }

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack spacing={1.5}>
        <DateEndpointEditor
          endpoint={range.from}
          offset={range.fromOffset}
          disabled={disabled}
          onChange={(nextFrom, nextOffset) => {
            const { fromOffset: _dropped, ...rest } = range;
            onChange({
              ...rest,
              from: nextFrom,
              ...(nextOffset ? { fromOffset: nextOffset } : {}),
            });
          }}
        />

        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={Boolean(range.to)}
                disabled={disabled || Boolean(range.openEnd)}
                onChange={(e) => {
                  const { to: _t, toOffset: _to, ...rest } = range;
                  if (e.target.checked) {
                    onChange({
                      ...rest,
                      to: { kind: "calendar", month: "Dec", day: 31 },
                    });
                  } else {
                    onChange(rest);
                  }
                }}
              />
            }
            label={<Typography variant="caption">{t("ohDateHasEnd")}</Typography>}
          />

          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={Boolean(range.openEnd)}
                disabled={disabled || Boolean(range.to)}
                onChange={(e) => {
                  const { openEnd: _o, ...rest } = range;
                  onChange(e.target.checked ? { ...rest, openEnd: true } : rest);
                }}
              />
            }
            label={<Typography variant="caption">{t("ohDateOpenEnd")}</Typography>}
          />

          <Button
            size="small"
            color="error"
            onClick={onRemove}
            disabled={disabled}
            sx={{ minHeight: 36 }}
          >
            {t("ohRemoveMonthdayRange")}
          </Button>
        </Stack>

        {range.to && (
          <DateEndpointEditor
            endpoint={range.to}
            offset={range.toOffset}
            disabled={disabled}
            onChange={(nextTo, nextOffset) => {
              const { toOffset: _dropped, ...rest } = range;
              onChange({
                ...rest,
                to: nextTo,
                ...(nextOffset ? { toOffset: nextOffset } : {}),
              });
            }}
          />
        )}
      </Stack>
    </Paper>
  );
}

interface DateEndpointEditorProps {
  endpoint: OsmDateEndpoint;
  offset?: OsmDateOffset;
  disabled: boolean;
  onChange: (nextEndpoint: OsmDateEndpoint, nextOffset?: OsmDateOffset) => void;
}

function DateEndpointEditor({ endpoint, offset, disabled, onChange }: DateEndpointEditorProps) {
  const t = useTranslations("osmContributions");

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}>
      <FormControl size="small" sx={{ minWidth: 145 }}>
        <InputLabel>{t("ohDateEndpointKind")}</InputLabel>
        <Select
          label={t("ohDateEndpointKind")}
          value={endpoint.kind}
          disabled={disabled}
          onChange={(e) => {
            const nextKind = e.target.value as OsmDateEndpoint["kind"];
            if (nextKind === "calendar") {
              onChange({ kind: "calendar", month: "Jan", day: 1 }, offset);
            } else if (nextKind === "nthWeekday") {
              onChange({ kind: "nthWeekday", month: "May", weekday: "Su", nth: 1 }, offset);
            } else {
              onChange({ kind: "easter" }, offset);
            }
          }}
        >
          <MenuItem value="calendar">{t("ohDateKindCalendar")}</MenuItem>
          <MenuItem value="nthWeekday">{t("ohDateKindNthWeekday")}</MenuItem>
          <MenuItem value="easter">{t("ohDateKindEaster")}</MenuItem>
        </Select>
      </FormControl>

      <TextField
        size="small"
        type="number"
        label={t("ohDateYearOptional")}
        value={endpoint.year ?? ""}
        disabled={disabled}
        sx={{ maxWidth: 115 }}
        onChange={(e) => {
          const raw = e.target.value.trim();
          const { year: _dropped, ...rest } = endpoint;
          if (!raw) {
            onChange(rest as OsmDateEndpoint, offset);
            return;
          }
          const val = Number.parseInt(raw, 10);
          if (Number.isFinite(val) && val > 1900) {
            onChange({ ...rest, year: val } as OsmDateEndpoint, offset);
          }
        }}
      />

      {endpoint.kind !== "easter" && (
        <FormControl size="small" sx={{ minWidth: 95 }}>
          <InputLabel>{t("ohDateMonth")}</InputLabel>
          <Select
            label={t("ohDateMonth")}
            value={endpoint.month}
            disabled={disabled}
            onChange={(e) => onChange({ ...endpoint, month: e.target.value as OsmMonth }, offset)}
          >
            {OSM_MONTHS.map((m) => (
              <MenuItem key={m} value={m}>
                {m}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}

      {endpoint.kind === "calendar" && (
        <TextField
          size="small"
          type="number"
          label={t("ohDateDay")}
          value={endpoint.day}
          disabled={disabled}
          sx={{ maxWidth: 95 }}
          onChange={(e) => {
            const val = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(val) && val >= 1 && val <= 31) {
              onChange({ ...endpoint, day: val }, offset);
            }
          }}
        />
      )}

      {endpoint.kind === "nthWeekday" && (
        <>
          <FormControl size="small" sx={{ minWidth: 90 }}>
            <InputLabel>{t("ohWeekdayFrom")}</InputLabel>
            <Select
              label={t("ohWeekdayFrom")}
              value={endpoint.weekday}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...endpoint, weekday: e.target.value as OsmWeekday }, offset)
              }
            >
              {OSM_WEEKDAYS.map((w) => (
                <MenuItem key={w} value={w}>
                  {t(WEEKDAY_LABEL_KEY[w])}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 85 }}>
            <InputLabel>Nth</InputLabel>
            <Select
              label="Nth"
              value={endpoint.nth}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...endpoint, nth: Number(e.target.value) as OsmNthValue }, offset)
              }
            >
              {VALID_NTH_VALUES.map((n) => (
                <MenuItem key={n} value={n}>
                  {n}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </>
      )}

      <TextField
        size="small"
        type="number"
        label={t("ohDayOffset")}
        value={offset?.dayOffset ?? ""}
        disabled={disabled}
        sx={{ maxWidth: 130 }}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (!raw || raw === "0") {
            const nextOffset = offset?.weekdayOffset
              ? { weekdayOffset: offset.weekdayOffset }
              : undefined;
            onChange(endpoint, nextOffset);
            return;
          }
          const num = Number.parseInt(raw, 10);
          if (Number.isFinite(num)) {
            onChange(endpoint, { ...offset, dayOffset: num });
          }
        }}
      />
    </Stack>
  );
}

interface WeekdayItemEditorProps {
  item: OsmWeekdaySelectorItem;
  disabled: boolean;
  onChange: (next: OsmWeekdaySelectorItem) => void;
  onRemove: () => void;
}

function WeekdayItemEditor({ item, disabled, onChange, onRemove }: WeekdayItemEditorProps) {
  const t = useTranslations("osmContributions");
  const [nthText, setNthText] = useState<string | null>(null);

  return (
    <Paper variant="outlined" sx={{ p: 1 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}>
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>{t("ohDaysAndHolidays")}</InputLabel>
          <Select
            label={t("ohDaysAndHolidays")}
            value={item.kind}
            disabled={disabled}
            onChange={(e) => {
              const nextKind = e.target.value as "weekday" | "holiday";
              setNthText(null);
              if (nextKind === "holiday") {
                onChange({ kind: "holiday", holiday: "PH" });
              } else {
                onChange({ kind: "weekday", from: "Mo" });
              }
            }}
          >
            <MenuItem value="weekday">{t("ohWeekdayKindWeekday")}</MenuItem>
            <MenuItem value="holiday">{t("ohWeekdayKindHoliday")}</MenuItem>
          </Select>
        </FormControl>

        {item.kind === "holiday" ? (
          <>
            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel>{t("ohWeekdayKindHoliday")}</InputLabel>
              <Select
                label={t("ohWeekdayKindHoliday")}
                value={item.holiday}
                disabled={disabled}
                onChange={(e) =>
                  onChange({
                    kind: "holiday",
                    holiday: e.target.value as OsmHoliday,
                  })
                }
              >
                <MenuItem value="PH">{t("ohHolidayPH")}</MenuItem>
                <MenuItem value="SH">{t("ohHolidaySH")}</MenuItem>
              </Select>
            </FormControl>

            {item.holiday === "PH" && (
              <TextField
                size="small"
                type="number"
                label={t("ohDayOffset")}
                value={item.dayOffset ?? ""}
                disabled={disabled}
                sx={{ maxWidth: 135 }}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const { dayOffset: _dropped, ...rest } = item;
                  if (!raw || raw === "0") {
                    onChange(rest);
                    return;
                  }
                  const val = Number.parseInt(raw, 10);
                  if (Number.isFinite(val)) {
                    onChange({ ...rest, dayOffset: val });
                  }
                }}
              />
            )}
          </>
        ) : (
          <>
            <FormControl size="small" sx={{ minWidth: 95 }}>
              <InputLabel>{t("ohWeekdayFrom")}</InputLabel>
              <Select
                label={t("ohWeekdayFrom")}
                value={item.from}
                disabled={disabled}
                onChange={(e) => onChange({ ...item, from: e.target.value as OsmWeekday })}
              >
                {OSM_WEEKDAYS.map((w) => (
                  <MenuItem key={w} value={w}>
                    {t(WEEKDAY_LABEL_KEY[w])}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 130 }}>
              <InputLabel>{t("ohWeekdayTo")}</InputLabel>
              <Select
                label={t("ohWeekdayTo")}
                value={item.to ?? ""}
                disabled={disabled}
                onChange={(e) => {
                  const val = e.target.value as OsmWeekday | "";
                  const { to: _t, nth: _n, dayOffset: _d, ...rest } = item;
                  onChange(val ? { ...rest, to: val } : rest);
                }}
              >
                <MenuItem value="">{t("ohWeekdayNone")}</MenuItem>
                {OSM_WEEKDAYS.map((w) => (
                  <MenuItem key={w} value={w}>
                    {t(WEEKDAY_LABEL_KEY[w])}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {!item.to && (
              <>
                <TextField
                  size="small"
                  label={t("ohWeekdayNth")}
                  value={nthText ?? formatNthEntries(item.nth)}
                  disabled={disabled}
                  placeholder="1,3,-1"
                  sx={{ maxWidth: 170 }}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setNthText(raw);
                    const parsed = parseNthEntriesInput(raw);
                    const { nth: _dropped, ...rest } = item;
                    onChange(parsed ? { ...rest, nth: parsed } : rest);
                  }}
                  onBlur={() => setNthText(null)}
                />

                <TextField
                  size="small"
                  type="number"
                  label={t("ohDayOffset")}
                  value={item.dayOffset ?? ""}
                  disabled={disabled}
                  sx={{ maxWidth: 135 }}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    const { dayOffset: _dropped, ...rest } = item;
                    if (!raw || raw === "0") {
                      onChange(rest);
                      return;
                    }
                    const val = Number.parseInt(raw, 10);
                    if (Number.isFinite(val)) {
                      onChange({ ...rest, dayOffset: val });
                    }
                  }}
                />
              </>
            )}
          </>
        )}

        <Button
          size="small"
          color="error"
          onClick={onRemove}
          disabled={disabled}
          sx={{ minHeight: 36 }}
        >
          {t("ohRemoveWeekdayItem")}
        </Button>
      </Stack>
    </Paper>
  );
}
