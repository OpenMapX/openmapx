/**
 * The transient state machine behind the OSM contribution editor.
 *
 * It is pure and holds only *semantic* draft state: which fields were chosen,
 * what operation each one carries, the person's evidence and comment. It never
 * copies the context's values, never holds a raw tag map, and is never
 * persisted — no storage, no URL, no analytics.
 *
 * Two invariants are enforced here rather than spread across components:
 * clearing a text box is a validation error and never an implicit deletion,
 * and a submission identity is regenerated whenever the semantic content
 * changes or an attempt fails.
 */
import {
  countCodePoints,
  OSM_MAX_CHANGES_PER_SUBMISSION,
  OSM_MAX_COMMENT_CODE_POINTS,
  OSM_MAX_EVIDENCE_DETAIL_CODE_POINTS,
  OSM_MIN_COMMENT_CODE_POINTS,
  OSM_MIN_EVIDENCE_DETAIL_CODE_POINTS,
  type OsmAddressField,
  type OsmAddressPatch,
  type OsmContributionContext,
  type OsmContributionPreview,
  type OsmContributionPublishResult,
  type OsmEditableFieldName,
  type OsmEvidence,
  type OsmFieldChange,
  type OsmNoteResult,
  type OsmScalarEditableField,
} from "@openmapx/core";

/** Why a field's current input cannot become an operation. */
export type OsmDraftFieldError = "EMPTY" | "TOO_LONG" | "FIELD_DISABLED";

type ScalarOperation =
  | { kind: "set"; value: string }
  | { kind: "remove" }
  | { kind: "category"; presetId: string; name: string };

type AddressOperation = { kind: "set"; value: string } | { kind: "remove" };

export interface OsmDraft {
  /** Chosen fields, in the order the person picked them. */
  selected: OsmEditableFieldName[];
  operations: Partial<Record<OsmEditableFieldName, ScalarOperation>>;
  addressOperations: Partial<Record<OsmAddressField, AddressOperation>>;
  errors: Partial<Record<OsmEditableFieldName, OsmDraftFieldError>>;
  evidence?: OsmEvidence;
  reviewRequested: boolean;
  comment: string;
}

/** A draft that carries everything publish requires. */
export type CompleteOsmDraft = OsmDraft & { evidence: OsmEvidence };

export interface OsmNoteDraft {
  text: string;
  submissionId?: string;
  submitting: boolean;
}

export type OsmContributionState =
  | { step: "closed" }
  | { step: "gate"; intent: "edit" | "note" }
  | {
      step: "edit";
      context: OsmContributionContext;
      draft: OsmDraft;
      confirmingDiscard: boolean;
    }
  | {
      step: "reviewing";
      context: OsmContributionContext;
      draft: OsmDraft;
      submissionId: string;
    }
  | {
      step: "review";
      context: OsmContributionContext;
      draft: OsmDraft;
      submissionId: string;
      preview: OsmContributionPreview;
      /** True after a failed attempt: a fresh id is required before retrying. */
      needsNewSubmissionId: boolean;
    }
  | {
      step: "publishing";
      context: OsmContributionContext;
      draft: CompleteOsmDraft;
      submissionId: string;
      preview: OsmContributionPreview;
    }
  | {
      step: "conflict";
      previous: OsmContributionContext;
      latest: OsmContributionContext;
      draft: CompleteOsmDraft;
    }
  | { step: "note"; context: OsmContributionContext; note: OsmNoteDraft }
  | { step: "success"; result: OsmContributionPublishResult | OsmNoteResult };

export type OsmContributionEvent =
  | { type: "open"; intent: "edit" | "note" }
  | { type: "contextLoaded"; context: OsmContributionContext }
  | { type: "selectField"; field: OsmEditableFieldName }
  | { type: "deselectField"; field: OsmEditableFieldName }
  | { type: "setText"; field: OsmScalarEditableField; value: string }
  | { type: "setCategory"; presetId: string; name: string }
  | { type: "setAddressText"; component: OsmAddressField; value: string }
  | { type: "removeValue"; field: OsmScalarEditableField }
  | { type: "removeAddressValue"; component: OsmAddressField }
  | { type: "undoRemove"; field: OsmScalarEditableField }
  | { type: "undoRemoveAddress"; component: OsmAddressField }
  | { type: "setEvidence"; evidence: OsmEvidence }
  | { type: "setComment"; comment: string }
  | { type: "setReviewRequested"; value: boolean }
  | { type: "requestReview"; submissionId: string }
  | { type: "previewLoaded"; preview: OsmContributionPreview }
  | { type: "previewFailed" }
  | { type: "backToEdit" }
  | { type: "publish" }
  | { type: "publishFailed" }
  | { type: "newSubmissionId"; submissionId: string }
  | { type: "published"; result: OsmContributionPublishResult }
  | { type: "conflict"; latest: OsmContributionContext }
  | { type: "adoptLatest"; submissionId: string }
  | { type: "openNote" }
  | { type: "setNoteText"; text: string }
  | { type: "submitNote"; submissionId: string }
  | { type: "noteCreated"; result: OsmNoteResult }
  | { type: "noteFailed" }
  | { type: "requestClose" }
  | { type: "cancelDiscard" }
  | { type: "confirmDiscard" }
  | { type: "reset" };

export const initialOsmContributionState: OsmContributionState = { step: "closed" };

export function emptyDraft(): OsmDraft {
  return {
    selected: [],
    operations: {},
    addressOperations: {},
    errors: {},
    reviewRequested: false,
    comment: "",
  };
}

function fieldOf(context: OsmContributionContext, field: OsmEditableFieldName) {
  return context.fields.find((candidate) => candidate.field === field);
}

function currentValueOf(
  context: OsmContributionContext,
  field: OsmScalarEditableField,
): string | null {
  const descriptor = fieldOf(context, field);
  if (descriptor?.kind === "text" || descriptor?.kind === "choice") return descriptor.currentValue;
  return null;
}

/** The semantic operations this draft would send. Order follows selection. */
export function selectedChanges(draft: OsmDraft): OsmFieldChange[] {
  const changes: OsmFieldChange[] = [];
  for (const field of draft.selected) {
    if (field === "address") {
      const value: Record<string, AddressOperation> = {};
      for (const [component, operation] of Object.entries(draft.addressOperations)) {
        if (operation) value[component] = operation;
      }
      if (Object.keys(value).length === 0) continue;
      changes.push({
        field: "address",
        action: "patch",
        value: Object.fromEntries(
          Object.entries(value).map(([component, operation]) => [
            component,
            operation.kind === "remove"
              ? { action: "remove" as const }
              : { action: "set" as const, value: operation.value },
          ]),
        ) as OsmAddressPatch,
      });
      continue;
    }
    const operation = draft.operations[field];
    if (!operation) continue;
    if (operation.kind === "category") {
      changes.push({ field: "category", action: "set", presetId: operation.presetId });
      continue;
    }
    if (field === "category") continue;
    changes.push(
      operation.kind === "remove"
        ? { field, action: "remove" }
        : { field, action: "set", value: operation.value },
    );
  }
  return changes;
}

export function isDraftDirty(draft: OsmDraft): boolean {
  return (
    selectedChanges(draft).length > 0 ||
    draft.comment.trim() !== "" ||
    draft.evidence !== undefined ||
    Object.keys(draft.errors).length > 0
  );
}

function isEvidenceComplete(evidence: OsmEvidence | undefined): boolean {
  if (!evidence) return false;
  if (evidence.kind !== "otherCompatible") return true;
  const detail = evidence.detail.trim();
  return (
    countCodePoints(detail) >= OSM_MIN_EVIDENCE_DETAIL_CODE_POINTS &&
    countCodePoints(detail) <= OSM_MAX_EVIDENCE_DETAIL_CODE_POINTS
  );
}

export function isCommentComplete(comment: string): boolean {
  const trimmed = comment.trim();
  const length = countCodePoints(trimmed);
  return length >= OSM_MIN_COMMENT_CODE_POINTS && length <= OSM_MAX_COMMENT_CODE_POINTS;
}

export function isDraftComplete(draft: OsmDraft): draft is CompleteOsmDraft {
  return (
    selectedChanges(draft).length > 0 &&
    Object.keys(draft.errors).length === 0 &&
    isEvidenceComplete(draft.evidence) &&
    isCommentComplete(draft.comment)
  );
}

/** Editing content invalidates any preview and its submission identity. */
function editing(
  state: Extract<OsmContributionState, { step: "edit" | "reviewing" | "review" }>,
  draft: OsmDraft,
): OsmContributionState {
  return { step: "edit", context: state.context, draft, confirmingDiscard: false };
}

function withoutField(draft: OsmDraft, field: OsmEditableFieldName): OsmDraft {
  const { [field]: _dropped, ...operations } = draft.operations;
  const { [field]: _droppedError, ...errors } = draft.errors;
  return {
    ...draft,
    operations,
    errors,
    ...(field === "address" ? { addressOperations: {} } : {}),
  };
}

/** Re-validate a carried-over draft against a newly fetched context. */
function revalidate(draft: OsmDraft, context: OsmContributionContext): OsmDraft {
  const errors: OsmDraft["errors"] = {};
  for (const field of draft.selected) {
    const descriptor = fieldOf(context, field);
    if (!descriptor?.enabled) errors[field] = "FIELD_DISABLED";
  }
  return { ...draft, errors };
}

export function osmContributionReducer(
  state: OsmContributionState,
  event: OsmContributionEvent,
): OsmContributionState {
  switch (event.type) {
    case "reset":
      return { step: "closed" };

    case "open":
      return { step: "gate", intent: event.intent };

    case "contextLoaded":
      if (state.step === "gate" && state.intent === "note") {
        return { step: "note", context: event.context, note: { text: "", submitting: false } };
      }
      if (state.step === "gate") {
        return {
          step: "edit",
          context: event.context,
          draft: emptyDraft(),
          confirmingDiscard: false,
        };
      }
      return state;

    case "openNote":
      if (state.step !== "edit" && state.step !== "note") return state;
      return { step: "note", context: state.context, note: { text: "", submitting: false } };

    case "setNoteText":
      if (state.step !== "note" || state.note.submitting) return state;
      return { ...state, note: { ...state.note, text: event.text } };

    case "submitNote":
      if (state.step !== "note" || state.note.submitting) return state;
      return {
        ...state,
        note: { ...state.note, submissionId: event.submissionId, submitting: true },
      };

    case "noteFailed":
      if (state.step !== "note") return state;
      // A new identity is required before another attempt.
      return {
        ...state,
        note: { text: state.note.text, submitting: false },
      };

    case "noteCreated":
      return { step: "success", result: event.result };

    default:
      break;
  }

  if (state.step === "edit" || state.step === "reviewing" || state.step === "review") {
    const draft = state.draft;
    switch (event.type) {
      case "selectField": {
        const descriptor = fieldOf(state.context, event.field);
        if (!descriptor?.enabled) return state;
        if (draft.selected.includes(event.field)) return state;
        if (draft.selected.length >= OSM_MAX_CHANGES_PER_SUBMISSION) return state;
        return editing(state, { ...draft, selected: [...draft.selected, event.field] });
      }

      case "deselectField":
        return editing(state, {
          ...withoutField(draft, event.field),
          selected: draft.selected.filter((field) => field !== event.field),
        });

      case "setText": {
        const value = event.value.trim();
        const next = withoutField(draft, event.field);
        if (value === "") {
          return editing(state, { ...next, errors: { ...next.errors, [event.field]: "EMPTY" } });
        }
        if (countCodePoints(value) > 255) {
          return editing(state, {
            ...next,
            errors: { ...next.errors, [event.field]: "TOO_LONG" },
          });
        }
        if (currentValueOf(state.context, event.field) === value) {
          // A no-op is simply not an operation.
          return editing(state, next);
        }
        return editing(state, {
          ...next,
          operations: { ...next.operations, [event.field]: { kind: "set", value } },
        });
      }

      case "setCategory":
        return editing(state, {
          ...withoutField(draft, "category"),
          operations: {
            ...withoutField(draft, "category").operations,
            category: { kind: "category", presetId: event.presetId, name: event.name },
          },
        });

      case "removeValue": {
        if (currentValueOf(state.context, event.field) === null) return state;
        const next = withoutField(draft, event.field);
        return editing(state, {
          ...next,
          operations: { ...next.operations, [event.field]: { kind: "remove" } },
        });
      }

      case "undoRemove":
        return editing(state, withoutField(draft, event.field));

      case "setAddressText": {
        const value = event.value.trim();
        const address = fieldOf(state.context, "address");
        const entry =
          address?.kind === "address"
            ? address.entries.find((candidate) => candidate.key === event.component)
            : undefined;
        if (!entry) return state;
        const addressOperations = { ...draft.addressOperations };
        if (value === "" || value === entry.currentValue) {
          delete addressOperations[event.component];
          const errors = { ...draft.errors };
          if (value === "") errors.address = "EMPTY";
          else delete errors.address;
          return editing(state, { ...draft, addressOperations, errors });
        }
        addressOperations[event.component] = { kind: "set", value };
        const errors = { ...draft.errors };
        delete errors.address;
        return editing(state, { ...draft, addressOperations, errors });
      }

      case "removeAddressValue": {
        const address = fieldOf(state.context, "address");
        const entry =
          address?.kind === "address"
            ? address.entries.find((candidate) => candidate.key === event.component)
            : undefined;
        if (!entry || entry.currentValue === "") return state;
        return editing(state, {
          ...draft,
          addressOperations: {
            ...draft.addressOperations,
            [event.component]: { kind: "remove" },
          },
        });
      }

      case "undoRemoveAddress": {
        const addressOperations = { ...draft.addressOperations };
        delete addressOperations[event.component];
        return editing(state, { ...draft, addressOperations });
      }

      // Evidence, comment and the review request do not change the tag result,
      // so they must not invalidate an existing preview or its identity.
      case "setEvidence":
        return { ...state, draft: { ...draft, evidence: event.evidence } };

      case "setComment":
        return { ...state, draft: { ...draft, comment: event.comment } };

      case "setReviewRequested":
        return { ...state, draft: { ...draft, reviewRequested: event.value } };

      case "requestClose":
        if (state.step !== "edit") return { step: "closed" };
        return isDraftDirty(draft) ? { ...state, confirmingDiscard: true } : { step: "closed" };

      case "cancelDiscard":
        return state.step === "edit" ? { ...state, confirmingDiscard: false } : state;

      case "confirmDiscard":
        return { step: "closed" };

      default:
        break;
    }
  }

  switch (event.type) {
    case "requestReview":
      if (state.step !== "edit" && state.step !== "review") return state;
      if (selectedChanges(state.draft).length === 0) return state;
      if (Object.keys(state.draft.errors).length > 0) return state;
      return {
        step: "reviewing",
        context: state.context,
        draft: state.draft,
        submissionId: event.submissionId,
      };

    case "previewLoaded":
      if (state.step !== "reviewing") return state;
      return {
        step: "review",
        context: state.context,
        draft: state.draft,
        submissionId: state.submissionId,
        preview: event.preview,
        needsNewSubmissionId: false,
      };

    case "previewFailed":
      if (state.step !== "reviewing") return state;
      return {
        step: "edit",
        context: state.context,
        draft: state.draft,
        confirmingDiscard: false,
      };

    case "backToEdit":
      if (state.step !== "review" && state.step !== "reviewing") return state;
      return {
        step: "edit",
        context: state.context,
        draft: state.draft,
        confirmingDiscard: false,
      };

    case "publish": {
      if (state.step !== "review") return state;
      if (state.needsNewSubmissionId) return state;
      if (!isDraftComplete(state.draft)) return state;
      return {
        step: "publishing",
        context: state.context,
        draft: state.draft,
        submissionId: state.submissionId,
        preview: state.preview,
      };
    }

    case "publishFailed":
      if (state.step !== "publishing") return state;
      return {
        step: "review",
        context: state.context,
        draft: state.draft,
        submissionId: state.submissionId,
        preview: state.preview,
        // The server treats a reused id as the original attempt, so a retry
        // must carry a new one.
        needsNewSubmissionId: true,
      };

    case "newSubmissionId":
      if (state.step !== "review") return state;
      return { ...state, submissionId: event.submissionId, needsNewSubmissionId: false };

    case "published":
      return { step: "success", result: event.result };

    case "conflict": {
      if (state.step !== "publishing") return state;
      return {
        step: "conflict",
        previous: state.context,
        latest: event.latest,
        draft: state.draft,
      };
    }

    case "adoptLatest": {
      if (state.step !== "conflict") return state;
      const draft = revalidate(state.draft, state.latest);
      if (Object.keys(draft.errors).length > 0) {
        return { step: "edit", context: state.latest, draft, confirmingDiscard: false };
      }
      return {
        step: "reviewing",
        context: state.latest,
        draft,
        submissionId: event.submissionId,
      };
    }

    case "requestClose":
      return { step: "closed" };

    default:
      return state;
  }
}
