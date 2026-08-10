"use client";

import CloseIcon from "@mui/icons-material/Close";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import {
  type OsmContributionContext,
  type OsmContributionErrorCode,
  type OsmContributionLocale,
  OsmContributionRequestError,
  type OsmEditableField,
  type OsmElementRef,
  safeHref,
  useCreateOsmNote,
  useInvalidateAfterContribution,
  useOsmContributionCapabilities,
  useOsmContributionContext,
  usePreviewOsmContribution,
  usePublishOsmContribution,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useReducer } from "react";
import { mobileFullScreenDialogPaperSx, useFullScreenOnMobile } from "@/lib/useFullScreenOnMobile";
import { OsmContributionChooser } from "./OsmContributionChooser";
import { OsmContributionForm } from "./OsmContributionForm";
import { OSM_CONTRIBUTE_CALLBACK_PARAM, OsmContributionGate } from "./OsmContributionGate";
import { OsmContributionReview } from "./OsmContributionReview";
import { OsmContributionSuccess } from "./OsmContributionSuccess";
import { OsmNoteForm } from "./OsmNoteForm";
import type { OsmDraft } from "./osmContributionDraft";
import {
  initialOsmContributionState,
  isDraftComplete,
  isDraftDirty,
  osmContributionReducer,
  selectedChanges,
} from "./osmContributionDraft";

const ERROR_KEY: Record<OsmContributionErrorCode, string> = {
  FEATURE_DISABLED: "errorFeatureDisabled",
  DIRECT_EDITING_DISABLED: "errorDirectEditingDisabled",
  OSM_ACCOUNT_NOT_LINKED: "errorAccountNotLinked",
  OSM_REAUTHORIZATION_REQUIRED: "errorReauthorizationRequired",
  CONTRIBUTOR_TERMS_REQUIRED: "errorContributorTerms",
  OSM_ACCOUNT_BLOCKED: "errorAccountBlocked",
  ELEMENT_NOT_FOUND: "errorElementNotFound",
  ELEMENT_DELETED: "errorElementDeleted",
  ELEMENT_NOT_ELIGIBLE: "errorElementNotEligible",
  FIELD_NOT_EDITABLE: "errorFieldNotEditable",
  INVALID_CHANGE: "errorInvalidChange",
  EMPTY_CHANGE: "errorEmptyChange",
  VERSION_CONFLICT: "errorVersionConflict",
  SUBMISSION_IN_PROGRESS: "errorSubmissionInProgress",
  RATE_LIMITED: "errorRateLimited",
  AMBIGUOUS_RESULT: "errorAmbiguousResult",
  OSM_UNAVAILABLE: "errorOsmUnavailable",
  UPSTREAM_INVALID: "errorUpstreamInvalid",
};

/** Consume the OAuth reopen marker without leaving it in the address bar. */
export function consumeContributeCallbackMarker(): boolean {
  if (typeof window === "undefined") return false;
  const url = new URL(window.location.href);
  if (url.searchParams.get(OSM_CONTRIBUTE_CALLBACK_PARAM) !== "1") return false;
  url.searchParams.delete(OSM_CONTRIBUTE_CALLBACK_PARAM);
  window.history.replaceState(null, "", url.toString());
  return true;
}

interface Props {
  open: boolean;
  ref_: OsmElementRef;
  onClose: () => void;
}

/**
 * The responsive contribution shell: a dialog on larger screens, a full-screen
 * flow on phones. It owns the transient state machine and the network calls,
 * and passes nothing but live server data into the editing components.
 */
export function OsmContributionDialog({ open, ref_, onClose }: Props) {
  const t = useTranslations("osmContributions");
  const locale = useLocale() as OsmContributionLocale;
  const fullScreen = useFullScreenOnMobile();
  const [state, dispatch] = useReducer(osmContributionReducer, initialOsmContributionState);

  const capabilities = useOsmContributionCapabilities(open);
  const context = useOsmContributionContext(ref_, locale, open);
  const preview = usePreviewOsmContribution();
  const publish = usePublishOsmContribution();
  const createNote = useCreateOsmNote();
  const invalidate = useInvalidateAfterContribution();

  // A new place means a new flow: never carry a draft across references.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on identity change only
  useEffect(() => {
    dispatch({ type: "reset" });
  }, [ref_.type, ref_.id]);

  const account = capabilities.data;
  const accountReady =
    account?.enabled === true &&
    account.linked &&
    account.contributorTermsAgreed &&
    !account.activeBlock;
  const canEdit = accountReady && account.canWriteApi && account.directEditingEnabled;
  const canNote = accountReady && account.canWriteNotes;

  /**
   * When direct editing is switched off or unauthorized but notes are still
   * permitted, the flow opens on the note path rather than dead-ending: the
   * design keeps the note and advanced-editor handoffs available wherever
   * their own permissions allow.
   */
  const gateIntent = canEdit || !canNote ? "edit" : "note";

  useEffect(() => {
    if (!open) return;
    if (state.step === "closed") {
      dispatch({ type: "open", intent: gateIntent });
      return;
    }
    if (state.step !== "gate") return;
    if (state.intent !== gateIntent) {
      dispatch({ type: "open", intent: gateIntent });
      return;
    }
    if (context.data && (canEdit || canNote)) {
      dispatch({ type: "contextLoaded", context: context.data });
    }
  }, [open, state, gateIntent, context.data, canEdit, canNote]);

  const close = useCallback(() => {
    invalidate(ref_);
    dispatch({ type: "reset" });
    onClose();
  }, [invalidate, onClose, ref_]);

  const requestClose = () => {
    if (state.step === "edit" && isDraftDirty(state.draft)) {
      dispatch({ type: "requestClose" });
      return;
    }
    close();
  };

  /**
   * Ask the server to rebuild the diff. The context and draft are passed
   * explicitly because a conflict adoption previews against the *latest*
   * context, which this render's `state` does not yet hold.
   */
  const requestPreview = async (
    forContext: OsmContributionContext,
    draft: OsmDraft,
    submissionId: string,
  ) => {
    try {
      const result = await preview.mutateAsync({
        ref: forContext.ref,
        baseVersion: forContext.version,
        changes: selectedChanges(draft),
        locale,
        idempotencyKey: submissionId,
      });
      dispatch({ type: "previewLoaded", preview: result });
    } catch {
      dispatch({ type: "previewFailed" });
    }
  };

  const runPreview = async () => {
    if (state.step !== "edit" && state.step !== "review") return;
    const submissionId = crypto.randomUUID();
    dispatch({ type: "requestReview", submissionId });
    await requestPreview(state.context, state.draft, submissionId);
  };

  const runPublish = async () => {
    if (state.step !== "review" || !isDraftComplete(state.draft)) return;
    // A previous attempt failed. Reusing its id would make the server replay
    // that attempt instead of publishing, so mint a fresh one for this retry;
    // the reducer applies it before the publish transition it gates.
    const submissionId = state.needsNewSubmissionId ? crypto.randomUUID() : state.submissionId;
    if (state.needsNewSubmissionId) {
      dispatch({ type: "newSubmissionId", submissionId });
    }
    dispatch({ type: "publish" });
    try {
      const result = await publish.mutateAsync({
        ref: state.context.ref,
        baseVersion: state.context.version,
        changes: selectedChanges(state.draft),
        locale,
        idempotencyKey: submissionId,
        evidence: state.draft.evidence,
        reviewRequested: state.draft.reviewRequested,
        comment: state.draft.comment.trim(),
      });
      dispatch({ type: "published", result });
    } catch (error) {
      if (
        error instanceof OsmContributionRequestError &&
        error.code === "VERSION_CONFLICT" &&
        error.context
      ) {
        dispatch({ type: "conflict", latest: error.context });
        return;
      }
      dispatch({ type: "publishFailed" });
    }
  };

  const runNote = async () => {
    if (state.step !== "note") return;
    const submissionId = crypto.randomUUID();
    dispatch({ type: "submitNote", submissionId });
    try {
      const result = await createNote.mutateAsync({
        ref: state.context.ref,
        text: state.note.text.trim(),
        idempotencyKey: submissionId,
      });
      dispatch({ type: "noteCreated", result });
    } catch {
      dispatch({ type: "noteFailed" });
    }
  };

  const adoptLatest = async () => {
    if (state.step !== "conflict") return;
    // Adopting is always followed by a fresh preview and an explicit publish;
    // a conflict can never reach OpenStreetMap on its own.
    const submissionId = crypto.randomUUID();
    const { latest, draft } = state;
    dispatch({ type: "adoptLatest", submissionId });
    await requestPreview(latest, draft, submissionId);
  };

  /**
   * Only the failure that belongs to the step being shown. TanStack keeps a
   * mutation's error until the next `mutate`, so chaining all of them would
   * render a stale publish error on top of a later successful preview.
   */
  const activeError =
    state.step === "review" || state.step === "publishing"
      ? (publish.error ?? preview.error ?? null)
      : state.step === "reviewing" || state.step === "edit"
        ? (preview.error ?? null)
        : state.step === "note"
          ? (createNote.error ?? null)
          : state.step === "gate"
            ? (context.error ?? null)
            : null;

  const title =
    state.step !== "closed" &&
    state.step !== "gate" &&
    "context" in state &&
    state.context.displayName
      ? t("dialogTitleNamed", { name: state.context.displayName })
      : t("dialogTitle");

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      fullWidth
      maxWidth="sm"
      fullScreen={fullScreen}
      slotProps={{ paper: { sx: mobileFullScreenDialogPaperSx } }}
      aria-labelledby="osm-contribution-title"
    >
      <DialogTitle
        id="osm-contribution-title"
        sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", pr: 1 }}
      >
        <Box component="span">{title}</Box>
        <IconButton onClick={requestClose} aria-label={t("close")} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers>
        {activeError && <ErrorNotice error={activeError} />}

        {state.step === "gate" && (
          <OsmContributionGate
            intent={state.intent}
            capabilities={capabilities.data}
            isLoading={capabilities.isPending || context.isPending}
            isError={capabilities.isError}
            hasUnsentInput={false}
            onRetry={() => void capabilities.refetch()}
          />
        )}

        {state.step === "edit" && (
          <Stack spacing={3}>
            <OsmContributionChooser
              context={state.context}
              selected={state.draft.selected}
              onToggleField={(field) =>
                dispatch(
                  state.draft.selected.includes(field)
                    ? { type: "deselectField", field }
                    : { type: "selectField", field },
                )
              }
              onOpenNote={() => dispatch({ type: "openNote" })}
            />
            {state.draft.selected.length > 0 && (
              <OsmContributionForm
                context={state.context}
                draft={state.draft}
                locale={locale}
                dispatch={dispatch}
              />
            )}
          </Stack>
        )}

        {state.step === "reviewing" && (
          <Stack spacing={2} sx={{ py: 4, alignItems: "center" }}>
            <CircularProgress size={28} />
            <Typography variant="body2" color="text.secondary">
              {t("reviewLoading")}
            </Typography>
          </Stack>
        )}

        {(state.step === "review" || state.step === "publishing") && (
          <OsmContributionReview
            preview={state.preview}
            draft={state.draft}
            accountName={capabilities.data?.account?.displayName}
            dispatch={dispatch}
          />
        )}

        {state.step === "conflict" && (
          <Stack spacing={2}>
            <Typography variant="subtitle1">{t("conflictTitle")}</Typography>
            <Typography variant="body2" color="text.secondary">
              {t("conflictBody")}
            </Typography>
            <ConflictDiff previous={state.previous} latest={state.latest} />
          </Stack>
        )}

        {state.step === "note" && (
          <OsmNoteForm
            context={state.context}
            note={state.note}
            onChange={(text) => dispatch({ type: "setNoteText", text })}
            onSubmit={() => void runNote()}
          />
        )}

        {state.step === "success" && <OsmContributionSuccess result={state.result} />}
      </DialogContent>

      <DialogActions sx={{ position: "sticky", bottom: 0, bgcolor: "background.paper" }}>
        {state.step === "edit" && (
          <Button
            variant="contained"
            disabled={
              selectedChanges(state.draft).length === 0 ||
              Object.keys(state.draft.errors).length > 0
            }
            onClick={() => void runPreview()}
            sx={{ minHeight: 44 }}
          >
            {t("reviewAction")}
          </Button>
        )}

        {(state.step === "review" || state.step === "publishing") && (
          <>
            <Button onClick={() => dispatch({ type: "backToEdit" })} sx={{ minHeight: 44 }}>
              {t("back")}
            </Button>
            <Button
              variant="contained"
              disabled={state.step === "publishing" || !isDraftComplete(state.draft)}
              onClick={() => void runPublish()}
              sx={{ minHeight: 44 }}
            >
              {state.step === "publishing" ? t("publishing") : t("publish")}
            </Button>
          </>
        )}

        {state.step === "conflict" && (
          <Button variant="contained" onClick={() => void adoptLatest()} sx={{ minHeight: 44 }}>
            {t("conflictAdopt")}
          </Button>
        )}

        {state.step === "success" && (
          <Button variant="contained" onClick={close} sx={{ minHeight: 44 }}>
            {t("successDone")}
          </Button>
        )}
      </DialogActions>

      <Dialog
        open={state.step === "edit" && state.confirmingDiscard}
        onClose={() => dispatch({ type: "cancelDiscard" })}
        aria-labelledby="osm-contribution-discard-title"
      >
        <DialogTitle id="osm-contribution-discard-title">{t("discardTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t("discardBody")}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => dispatch({ type: "cancelDiscard" })}>{t("discardKeep")}</Button>
          <Button color="warning" onClick={close}>
            {t("discardConfirm")}
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}

/** Renders only a translated code — never the payload's own text. */
function ErrorNotice({ error }: { error: OsmContributionRequestError }) {
  const t = useTranslations("osmContributions");
  const key = ERROR_KEY[error.code] ?? "errorGeneric";
  return (
    <Alert severity="error" sx={{ mb: 2 }}>
      {error.code === "RATE_LIMITED"
        ? t("errorRateLimited", { seconds: error.retryAfterSeconds ?? 60 })
        : t(key)}
      {error.inspect && (
        <Stack spacing={0.5} sx={{ mt: 1 }}>
          {error.inspect.changesetUrl && (
            <a
              href={safeHref(error.inspect.changesetUrl)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {error.inspect.changesetUrl}
            </a>
          )}
          {error.inspect.elementUrl && (
            <a href={safeHref(error.inspect.elementUrl)} target="_blank" rel="noopener noreferrer">
              {error.inspect.elementUrl}
            </a>
          )}
        </Stack>
      )}
    </Alert>
  );
}

/** Shows what changed upstream between the two live contexts. */
function ConflictDiff({
  previous,
  latest,
}: {
  previous: OsmContributionContext;
  latest: OsmContributionContext;
}) {
  const t = useTranslations("osmContributions");
  const rows = latest.fields.flatMap((field) => {
    const before = previous.fields.find((candidate) => candidate.field === field.field);
    const beforeValue = fieldValueOf(before);
    const afterValue = fieldValueOf(field);
    if (beforeValue === afterValue) return [];
    return [{ label: field.label, before: beforeValue, after: afterValue }];
  });

  if (rows.length === 0) return null;

  return (
    <Stack spacing={1}>
      {rows.map((row) => (
        <Box key={row.label}>
          <Typography variant="body2" color="text.secondary">
            {row.label}
          </Typography>
          <Typography variant="body2">
            {t("conflictBefore")}: {row.before ?? t("reviewNotSet")}
          </Typography>
          <Typography variant="body2">
            {t("conflictNow")}: {row.after ?? t("reviewNotSet")}
          </Typography>
        </Box>
      ))}
    </Stack>
  );
}

function fieldValueOf(field: OsmEditableField | undefined): string | null {
  if (!field) return null;
  switch (field.kind) {
    case "text":
    case "choice":
      return field.currentValue;
    case "category":
      return field.currentPresetName;
    default:
      return field.entries.map((entry) => entry.currentValue).join(", ") || null;
  }
}
