"use client";

import AddIcon from "@mui/icons-material/Add";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import RemoveIcon from "@mui/icons-material/Remove";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormLabel from "@mui/material/FormLabel";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  countCodePoints,
  OSM_MAX_COMMENT_CODE_POINTS,
  type OsmContributionPreview,
  type OsmEvidence,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  isCommentComplete,
  type OsmContributionEvent,
  type OsmDraft,
} from "./osmContributionDraft";

interface Props {
  preview: OsmContributionPreview;
  draft: OsmDraft;
  /** The linked OpenStreetMap display name, for the public-attribution notice. */
  accountName: string | undefined;
  dispatch: (event: OsmContributionEvent) => void;
}

/**
 * The mandatory review screen. Everything shown here comes from the
 * server-authoritative preview — the browser never computes a tag diff — and
 * the changeset comment is always the person's own words.
 */
export function OsmContributionReview({ preview, draft, accountName, dispatch }: Props) {
  const t = useTranslations("osmContributions");
  const commentLength = countCodePoints(draft.comment.trim());
  const commentInvalid = draft.comment !== "" && !isCommentComplete(draft.comment);

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="subtitle1" gutterBottom>
          {t("reviewChanges")}
        </Typography>
        <Stack spacing={1}>
          {preview.changes.map((change) => (
            <Box key={`${change.field}-${change.label}`}>
              <Typography variant="body2" color="text.secondary">
                {change.label}
              </Typography>
              <Typography variant="body2">
                <Box component="span" sx={{ textDecoration: "line-through", opacity: 0.7 }}>
                  {change.before ?? t("reviewNotSet")}
                </Box>{" "}
                →{" "}
                <Box component="span" sx={{ fontWeight: 600 }}>
                  {change.after ?? t("reviewRemoved")}
                </Box>
              </Typography>
            </Box>
          ))}
        </Stack>
      </Box>

      <Accordion disableGutters>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle2">{t("reviewExactTags")}</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Stack spacing={0.5}>
            {preview.tagDiff.add.map((tag) => (
              <TagLine
                key={`add-${tag.key}`}
                icon={<AddIcon fontSize="inherit" color="success" />}
                label={t("reviewTagAdded")}
                text={`${tag.key}=${tag.value}`}
              />
            ))}
            {preview.tagDiff.replace.map((tag) => (
              <TagLine
                key={`replace-${tag.key}`}
                icon={<SwapHorizIcon fontSize="inherit" color="info" />}
                label={t("reviewTagReplaced")}
                text={`${tag.key}: ${tag.from} → ${tag.to}`}
              />
            ))}
            {preview.tagDiff.remove.map((tag) => (
              <TagLine
                key={`remove-${tag.key}`}
                icon={<RemoveIcon fontSize="inherit" color="warning" />}
                label={t("reviewTagRemoved")}
                text={`${tag.key}=${tag.value}`}
              />
            ))}
          </Stack>
        </AccordionDetails>
      </Accordion>

      {preview.requiresReview && <Alert severity="info">{t("reviewRecommended")}</Alert>}

      <FormControl component="fieldset">
        <FormLabel component="legend">{t("evidenceTitle")}</FormLabel>
        <RadioGroup
          value={draft.evidence?.kind ?? ""}
          onChange={(event) => {
            const kind = event.target.value as OsmEvidence["kind"];
            dispatch({
              type: "setEvidence",
              evidence:
                kind === "otherCompatible" ? { kind, detail: "" } : ({ kind } as OsmEvidence),
            });
          }}
        >
          {[
            ["survey", "evidenceSurvey"],
            ["signage", "evidenceSignage"],
            ["officialWebsite", "evidenceOfficialWebsite"],
            ["otherCompatible", "evidenceOtherCompatible"],
          ].map(([value, key]) => (
            <FormControlLabel
              key={value}
              value={value}
              control={<Radio />}
              label={t(key as string)}
              sx={{ minHeight: 44 }}
            />
          ))}
        </RadioGroup>
        {draft.evidence?.kind === "otherCompatible" && (
          <TextField
            size="small"
            label={t("evidenceOtherDetail")}
            helperText={t("evidenceOtherDetailHelp")}
            value={draft.evidence.detail}
            onChange={(event) =>
              dispatch({
                type: "setEvidence",
                evidence: { kind: "otherCompatible", detail: event.target.value },
              })
            }
          />
        )}
        <Alert severity="warning" sx={{ mt: 1 }}>
          {t("evidenceWarning")}
        </Alert>
      </FormControl>

      <TextField
        fullWidth
        multiline
        minRows={2}
        label={t("reviewCommentLabel")}
        // Never suggested, autocompleted or derived from the diff.
        value={draft.comment}
        error={commentInvalid}
        helperText={`${t("reviewCommentHelp")} · ${t("reviewCommentCount", {
          count: commentLength,
          max: OSM_MAX_COMMENT_CODE_POINTS,
        })}`}
        onChange={(event) => dispatch({ type: "setComment", comment: event.target.value })}
      />

      <FormControlLabel
        control={
          <Checkbox
            checked={draft.reviewRequested}
            onChange={(event) =>
              dispatch({ type: "setReviewRequested", value: event.target.checked })
            }
          />
        }
        label={t("reviewRequestLabel")}
        sx={{ minHeight: 44 }}
      />

      <Alert severity="info">{t("publicNotice", { name: accountName ?? "" })}</Alert>
    </Stack>
  );
}

function TagLine({ icon, label, text }: { icon: ReactNode; label: string; text: string }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      {icon}
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 72 }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
        {text}
      </Typography>
    </Stack>
  );
}
