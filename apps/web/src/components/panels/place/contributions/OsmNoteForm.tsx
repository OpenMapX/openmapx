"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  countCodePoints,
  OSM_MAX_NOTE_CODE_POINTS,
  OSM_MIN_NOTE_CODE_POINTS,
  type OsmContributionContext,
  safeHref,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { OsmNoteDraft } from "./osmContributionDraft";

export function isNoteTextComplete(text: string): boolean {
  const length = countCodePoints(text.trim());
  return length >= OSM_MIN_NOTE_CODE_POINTS && length <= OSM_MAX_NOTE_CODE_POINTS;
}

interface Props {
  context: OsmContributionContext;
  note: OsmNoteDraft;
  onChange: (text: string) => void;
  onSubmit: () => void;
}

/**
 * A public OpenStreetMap note in the contributor's own words. The form starts
 * empty and never pre-fills a correction; the server re-reads the element and
 * computes the coordinates, so nothing positional is collected here.
 */
export function OsmNoteForm({ context, note, onChange, onSubmit }: Props) {
  const t = useTranslations("osmContributions");
  const length = countCodePoints(note.text.trim());
  const canSubmit = context.center !== null && isNoteTextComplete(note.text) && !note.submitting;

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle1">{t("noteTitle")}</Typography>
      <Alert severity="info">{t("noteDisclosure")}</Alert>
      <Typography variant="body2" color="text.secondary">
        {t("noteNotFeedback")}
      </Typography>

      {context.center === null ? (
        <Alert severity="warning">{t("noteNoLocation")}</Alert>
      ) : (
        <TextField
          fullWidth
          multiline
          minRows={4}
          label={t("noteLabel")}
          value={note.text}
          disabled={note.submitting}
          helperText={`${t("noteHelp")} · ${length}`}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      <Button variant="contained" disabled={!canSubmit} onClick={onSubmit} sx={{ minHeight: 44 }}>
        {note.submitting ? t("noteSubmitting") : t("noteSubmit")}
      </Button>

      <Button
        component="a"
        href={safeHref(context.advancedEditorUrl)}
        target="_blank"
        rel="noopener noreferrer"
        sx={{ minHeight: 44 }}
      >
        {t("actionAdvanced")}
      </Button>
    </Stack>
  );
}
