"use client";

import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormLabel from "@mui/material/FormLabel";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  type OsmAddressField,
  type OsmContributionContext,
  type OsmContributionLocale,
  type OsmEditableField,
  type OsmEditableFieldName,
  type OsmScalarEditableField,
  useOsmContributionCategories,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { OsmContributionEvent, OsmDraft } from "./osmContributionDraft";

const ERROR_KEY = {
  EMPTY: "fieldEmptyError",
  TOO_LONG: "fieldTooLongError",
  FIELD_DISABLED: "fieldDisabledError",
} as const;

interface Props {
  context: OsmContributionContext;
  draft: OsmDraft;
  locale: OsmContributionLocale;
  dispatch: (event: OsmContributionEvent) => void;
}

/**
 * Renders a control per selected field, always beside the live OpenStreetMap
 * value. Nothing here constructs a tag: a category selection sends only a
 * preset id, and the server owns every key.
 */
export function OsmContributionForm({ context, draft, locale, dispatch }: Props) {
  const t = useTranslations("osmContributions");

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={1} sx={{ overflowX: "auto", pb: 1 }}>
        {draft.selected.map((field) => (
          <Chip
            key={field}
            label={context.fields.find((candidate) => candidate.field === field)?.label ?? field}
            onDelete={() => dispatch({ type: "deselectField", field })}
            sx={{ minHeight: 32 }}
          />
        ))}
      </Stack>

      {draft.selected.map((field) => {
        const descriptor = context.fields.find((candidate) => candidate.field === field);
        if (!descriptor) return null;
        return (
          <FieldControl
            key={field}
            descriptor={descriptor}
            context={context}
            draft={draft}
            locale={locale}
            dispatch={dispatch}
          />
        );
      })}

      <Alert severity="info" icon={false}>
        <Typography variant="body2">{t("evidenceTitle")}</Typography>
        <Typography variant="body2" color="text.secondary">
          {t("evidenceSurvey")} · {t("evidenceSignage")} · {t("evidenceOfficialWebsite")}
        </Typography>
        <Typography variant="body2" sx={{ mt: 1 }}>
          {t("evidenceWarning")}
        </Typography>
      </Alert>
    </Stack>
  );
}

function FieldControl({
  descriptor,
  context,
  draft,
  locale,
  dispatch,
}: {
  descriptor: OsmEditableField;
  context: OsmContributionContext;
  draft: OsmDraft;
  locale: OsmContributionLocale;
  dispatch: (event: OsmContributionEvent) => void;
}) {
  const t = useTranslations("osmContributions");
  const error = draft.errors[descriptor.field as OsmEditableFieldName];
  const helper = error ? t(ERROR_KEY[error]) : undefined;

  if (descriptor.kind === "category") {
    return (
      <CategoryControl
        descriptor={descriptor}
        context={context}
        draft={draft}
        locale={locale}
        dispatch={dispatch}
      />
    );
  }

  if (descriptor.kind === "address") {
    return (
      <FormControl component="fieldset" fullWidth>
        <FormLabel component="legend">{descriptor.label}</FormLabel>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {descriptor.entries.map((entry) => {
            const operation = draft.addressOperations[entry.key as OsmAddressField];
            const removed = operation?.kind === "remove";
            return (
              <Box key={entry.key}>
                <TextField
                  fullWidth
                  size="small"
                  label={entry.label}
                  defaultValue={entry.currentValue}
                  disabled={removed}
                  onChange={(event) =>
                    dispatch({
                      type: "setAddressText",
                      component: entry.key as OsmAddressField,
                      value: event.target.value,
                    })
                  }
                  helperText={`${t("currentValue")}: ${entry.currentValue}`}
                />
                <RemoveToggle
                  removed={removed}
                  hasValue={entry.currentValue !== ""}
                  onRemove={() =>
                    dispatch({
                      type: "removeAddressValue",
                      component: entry.key as OsmAddressField,
                    })
                  }
                  onUndo={() =>
                    dispatch({
                      type: "undoRemoveAddress",
                      component: entry.key as OsmAddressField,
                    })
                  }
                />
              </Box>
            );
          })}
        </Stack>
        {helper && (
          <Typography variant="caption" color="error">
            {helper}
          </Typography>
        )}
      </FormControl>
    );
  }

  const field = descriptor.field as OsmScalarEditableField;
  const removed = draft.operations[field]?.kind === "remove";

  if (descriptor.kind === "choice") {
    return (
      <FormControl component="fieldset" disabled={removed}>
        <FormLabel component="legend">{descriptor.label}</FormLabel>
        <RadioGroup
          value={
            draft.operations[field]?.kind === "set"
              ? (draft.operations[field] as { value: string }).value
              : (descriptor.currentValue ?? "")
          }
          onChange={(event) => dispatch({ type: "setText", field, value: event.target.value })}
        >
          {descriptor.options.map((option) => (
            <FormControlLabel
              key={option.value}
              value={option.value}
              control={<Radio />}
              label={option.label}
              sx={{ minHeight: 44 }}
            />
          ))}
        </RadioGroup>
        <RemoveToggle
          removed={removed}
          hasValue={descriptor.currentValue !== null}
          onRemove={() => dispatch({ type: "removeValue", field })}
          onUndo={() => dispatch({ type: "undoRemove", field })}
        />
      </FormControl>
    );
  }

  return (
    <Box>
      <TextField
        fullWidth
        size="small"
        label={descriptor.label}
        defaultValue={descriptor.currentValue ?? ""}
        disabled={removed}
        error={Boolean(error)}
        helperText={
          helper ?? `${t("currentValue")}: ${descriptor.currentValue ?? t("chooserEmptyValue")}`
        }
        slotProps={{ htmlInput: { maxLength: descriptor.maxCodePoints * 2 } }}
        onChange={(event) => dispatch({ type: "setText", field, value: event.target.value })}
      />
      <RemoveToggle
        removed={removed}
        hasValue={descriptor.currentValue !== null}
        onRemove={() => dispatch({ type: "removeValue", field })}
        onUndo={() => dispatch({ type: "undoRemove", field })}
      />
    </Box>
  );
}

/**
 * Removal is always a separate, explicit action, and only offered when there
 * is a live value to remove.
 */
function RemoveToggle({
  removed,
  hasValue,
  onRemove,
  onUndo,
}: {
  removed: boolean;
  hasValue: boolean;
  onRemove: () => void;
  onUndo: () => void;
}) {
  const t = useTranslations("osmContributions");
  if (!hasValue) return null;
  if (removed) {
    return (
      <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: "center" }}>
        <Chip color="warning" size="small" label={t("willBeRemoved")} />
        <Button size="small" onClick={onUndo} sx={{ minHeight: 44 }}>
          {t("undoRemove")}
        </Button>
      </Stack>
    );
  }
  return (
    <Box sx={{ mt: 1 }}>
      <Button size="small" color="warning" onClick={onRemove} sx={{ minHeight: 44 }}>
        {t("removeValue")}
      </Button>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
        {t("removeValueHelp")}
      </Typography>
    </Box>
  );
}

function CategoryControl({
  descriptor,
  context,
  draft,
  locale,
  dispatch,
}: {
  descriptor: Extract<OsmEditableField, { kind: "category" }>;
  context: OsmContributionContext;
  draft: OsmDraft;
  locale: OsmContributionLocale;
  dispatch: (event: OsmContributionEvent) => void;
}) {
  const t = useTranslations("osmContributions");
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");

  // Debounced so a bounded server search runs per pause, not per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input), 250);
    return () => clearTimeout(timer);
  }, [input]);

  const suggestions = useOsmContributionCategories(
    { ref: context.ref, geometry: context.geometry, locale, query },
    true,
  );

  const selected = draft.operations.category;
  const selectedName = selected?.kind === "category" ? selected.name : null;

  return (
    <Box>
      <Autocomplete
        options={suggestions.data ?? []}
        loading={suggestions.isFetching}
        getOptionLabel={(option) => option.name}
        isOptionEqualToValue={(option, value) => option.presetId === value.presetId}
        filterOptions={(options) => options}
        noOptionsText={query.length >= 2 ? t("categoryNoResults") : t("categorySearchHelp")}
        onInputChange={(_event, value) => setInput(value)}
        onChange={(_event, option) => {
          // Only the stable preset id is ever sent; tags come from the server.
          if (option) {
            dispatch({ type: "setCategory", presetId: option.presetId, name: option.name });
          }
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            size="small"
            label={t("categorySearchLabel")}
            helperText={`${t("currentValue")}: ${
              descriptor.currentPresetName ?? t("chooserEmptyValue")
            }`}
          />
        )}
      />
      {selectedName && <Chip sx={{ mt: 1 }} color="primary" size="small" label={selectedName} />}
    </Box>
  );
}
