import type { OsmContributionContext, OsmContributionPreview } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import {
  type CompleteOsmDraft,
  emptyDraft,
  initialOsmContributionState,
  isDraftComplete,
  isDraftDirty,
  type OsmContributionState,
  osmContributionReducer,
  selectedChanges,
} from "./osmContributionDraft";

const UUID_A = "3f4b2a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const UUID_B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const COMMENT = "Corrected the name from the sign on the door";

const CONTEXT: OsmContributionContext = {
  ref: { type: "node", id: 12 },
  version: 4,
  geometry: "point",
  center: { lat: 52.5, lon: 13.4 },
  displayName: "Café Central",
  currentPreset: { status: "matched", presetId: "amenity/cafe", name: "Cafe" },
  fields: [
    {
      kind: "text",
      field: "name",
      label: "Name",
      currentValue: "Café Central",
      maxCodePoints: 255,
      enabled: true,
    },
    {
      kind: "text",
      field: "phone",
      label: "Phone",
      currentValue: null,
      maxCodePoints: 255,
      enabled: true,
    },
    {
      kind: "text",
      field: "website",
      label: "Website",
      currentValue: "https://cafe.example",
      maxCodePoints: 255,
      enabled: true,
    },
    {
      kind: "choice",
      field: "wheelchair",
      label: "Wheelchair access",
      currentValue: "limited",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
      enabled: true,
    },
    {
      kind: "category",
      field: "category",
      label: "Category",
      currentPresetId: "amenity/cafe",
      currentPresetName: "Cafe",
      enabled: true,
    },
    {
      kind: "address",
      field: "address",
      label: "Address",
      entries: [
        { key: "street", label: "Street", currentValue: "Hauptstraße" },
        { key: "houseNumber", label: "House number", currentValue: "1" },
      ],
      enabled: true,
    },
  ],
  advancedEditorUrl: "https://www.openstreetmap.org/edit?editor=id&node=12",
  elementUrl: "https://www.openstreetmap.org/node/12",
  fetchedAt: "2026-08-10T09:00:00.000Z",
};

const PREVIEW: OsmContributionPreview = {
  ref: CONTEXT.ref,
  baseVersion: 4,
  changes: [{ field: "name", label: "Name", action: "set", before: "A", after: "B" }],
  tagDiff: { add: [], replace: [{ key: "name", from: "A", to: "B" }], remove: [] },
  warnings: [],
  requiresReview: false,
};

function reduce(
  state: OsmContributionState,
  ...events: Parameters<typeof osmContributionReducer>[1][]
): OsmContributionState {
  return events.reduce(osmContributionReducer, state);
}

function edited(): OsmContributionState {
  return reduce(
    initialOsmContributionState,
    { type: "open", intent: "edit" },
    { type: "contextLoaded", context: CONTEXT },
    { type: "selectField", field: "name" },
    { type: "setText", field: "name", value: "Café Zentral" },
  );
}

describe("opening and resetting", () => {
  it("starts closed and opens into the gate", () => {
    expect(initialOsmContributionState).toEqual({ step: "closed" });
    expect(reduce(initialOsmContributionState, { type: "open", intent: "edit" })).toEqual({
      step: "gate",
      intent: "edit",
    });
  });

  it("moves to the chooser once the live context arrives", () => {
    const state = reduce(
      initialOsmContributionState,
      { type: "open", intent: "edit" },
      { type: "contextLoaded", context: CONTEXT },
    );
    expect(state).toMatchObject({ step: "edit", context: CONTEXT });
  });

  it("resets immediately when the place reference changes", () => {
    expect(reduce(edited(), { type: "reset" })).toEqual({ step: "closed" });
  });
});

describe("field selection", () => {
  it("selects unique fields up to the submission limit", () => {
    let state = reduce(
      initialOsmContributionState,
      { type: "open", intent: "edit" },
      { type: "contextLoaded", context: CONTEXT },
    );
    for (const field of [
      "name",
      "phone",
      "website",
      "wheelchair",
      "category",
      "address",
    ] as const) {
      state = osmContributionReducer(state, { type: "selectField", field });
      state = osmContributionReducer(state, { type: "selectField", field });
    }
    expect(state.step).toBe("edit");
    if (state.step !== "edit") return;
    expect(state.draft.selected).toEqual([
      "name",
      "phone",
      "website",
      "wheelchair",
      "category",
      "address",
    ]);
  });

  it("refuses a field the live context does not offer or has disabled", () => {
    const disabled: OsmContributionContext = {
      ...CONTEXT,
      fields: CONTEXT.fields.map((field) =>
        field.field === "phone"
          ? { ...field, enabled: false, disabledReason: "ALIAS_CONFLICT" as const }
          : field,
      ),
    };
    const state = reduce(
      initialOsmContributionState,
      { type: "open", intent: "edit" },
      { type: "contextLoaded", context: disabled },
      { type: "selectField", field: "phone" },
      { type: "selectField", field: "email" },
    );
    if (state.step !== "edit") throw new Error("expected edit");
    expect(state.draft.selected).toEqual([]);
  });

  it("drops a field's change when it is deselected", () => {
    const state = reduce(edited(), { type: "deselectField", field: "name" });
    if (state.step !== "edit") throw new Error("expected edit");
    expect(state.draft.selected).toEqual([]);
    expect(selectedChanges(state.draft)).toEqual([]);
  });
});

describe("explicit values and removal", () => {
  it("produces a set operation from typed text", () => {
    const state = edited();
    if (state.step !== "edit") throw new Error("expected edit");
    expect(selectedChanges(state.draft)).toEqual([
      { field: "name", action: "set", value: "Café Zentral" },
    ]);
  });

  it("treats an emptied text box as a validation error, never a deletion", () => {
    const state = reduce(edited(), { type: "setText", field: "name", value: "  " });
    if (state.step !== "edit") throw new Error("expected edit");
    expect(selectedChanges(state.draft)).toEqual([]);
    expect(state.draft.errors.name).toBeDefined();
  });

  it("requires an explicit remove action, available only when a value exists", () => {
    const removed = reduce(edited(), { type: "removeValue", field: "name" });
    if (removed.step !== "edit") throw new Error("expected edit");
    expect(selectedChanges(removed.draft)).toEqual([{ field: "name", action: "remove" }]);

    // `phone` has no current value, so there is nothing to remove.
    const noValue = reduce(
      initialOsmContributionState,
      { type: "open", intent: "edit" },
      { type: "contextLoaded", context: CONTEXT },
      { type: "selectField", field: "phone" },
      { type: "removeValue", field: "phone" },
    );
    if (noValue.step !== "edit") throw new Error("expected edit");
    expect(selectedChanges(noValue.draft)).toEqual([]);
  });

  it("lets a removal be undone back to an untouched field", () => {
    const state = reduce(
      edited(),
      { type: "removeValue", field: "name" },
      { type: "undoRemove", field: "name" },
    );
    if (state.step !== "edit") throw new Error("expected edit");
    expect(selectedChanges(state.draft)).toEqual([]);
  });

  it("builds an address patch from explicit component operations", () => {
    const state = reduce(
      initialOsmContributionState,
      { type: "open", intent: "edit" },
      { type: "contextLoaded", context: CONTEXT },
      { type: "selectField", field: "address" },
      { type: "setAddressText", component: "houseNumber", value: "1a" },
      { type: "removeAddressValue", component: "street" },
    );
    if (state.step !== "edit") throw new Error("expected edit");
    expect(selectedChanges(state.draft)).toEqual([
      {
        field: "address",
        action: "patch",
        value: {
          houseNumber: { action: "set", value: "1a" },
          street: { action: "remove" },
        },
      },
    ]);
  });

  it("sends only the selected category preset id", () => {
    const state = reduce(
      initialOsmContributionState,
      { type: "open", intent: "edit" },
      { type: "contextLoaded", context: CONTEXT },
      { type: "selectField", field: "category" },
      { type: "setCategory", presetId: "amenity/restaurant", name: "Restaurant" },
    );
    if (state.step !== "edit") throw new Error("expected edit");
    expect(selectedChanges(state.draft)).toEqual([
      { field: "category", action: "set", presetId: "amenity/restaurant" },
    ]);
    expect(JSON.stringify(state.draft)).not.toContain('amenity":');
  });

  it("ignores a no-op set that matches the live value", () => {
    const state = reduce(edited(), { type: "setText", field: "name", value: "Café Central" });
    if (state.step !== "edit") throw new Error("expected edit");
    expect(selectedChanges(state.draft)).toEqual([]);
  });
});

describe("evidence, comment and review request", () => {
  it("starts with no evidence, an empty comment and no review request", () => {
    const draft = emptyDraft();
    expect(draft.evidence).toBeUndefined();
    expect(draft.comment).toBe("");
    expect(draft.reviewRequested).toBe(false);
  });

  it("records each evidence variant, including a compatible-source detail", () => {
    let state = reduce(edited(), { type: "setEvidence", evidence: { kind: "survey" } });
    if (state.step !== "edit") throw new Error("expected edit");
    expect(state.draft.evidence).toEqual({ kind: "survey" });

    state = reduce(state, {
      type: "setEvidence",
      evidence: { kind: "otherCompatible", detail: "City open data" },
    });
    if (state.step !== "edit") throw new Error("expected edit");
    expect(state.draft.evidence).toEqual({ kind: "otherCompatible", detail: "City open data" });
  });

  it("keeps the comment exactly as typed", () => {
    const state = reduce(edited(), { type: "setComment", comment: COMMENT });
    if (state.step !== "edit") throw new Error("expected edit");
    expect(state.draft.comment).toBe(COMMENT);
  });

  it("is complete only with a change, evidence and a long-enough comment", () => {
    let state = edited();
    if (state.step !== "edit") throw new Error("expected edit");
    expect(isDraftComplete(state.draft)).toBe(false);

    state = reduce(state, { type: "setEvidence", evidence: { kind: "survey" } });
    if (state.step !== "edit") throw new Error("expected edit");
    expect(isDraftComplete(state.draft)).toBe(false);

    state = reduce(state, { type: "setComment", comment: "too short" });
    if (state.step !== "edit") throw new Error("expected edit");
    expect(isDraftComplete(state.draft)).toBe(false);

    state = reduce(state, { type: "setComment", comment: COMMENT });
    if (state.step !== "edit") throw new Error("expected edit");
    expect(isDraftComplete(state.draft)).toBe(true);
  });

  it("requires a detail for the compatible-source evidence kind only", () => {
    const state = reduce(
      edited(),
      { type: "setComment", comment: COMMENT },
      { type: "setEvidence", evidence: { kind: "otherCompatible", detail: "ab" } },
    );
    if (state.step !== "edit") throw new Error("expected edit");
    expect(isDraftComplete(state.draft)).toBe(false);
  });
});

describe("submission identity", () => {
  it("takes a supplied UUID when review is requested and reuses it for publish", () => {
    const state = reduce(edited(), { type: "requestReview", submissionId: UUID_A });
    expect(state).toMatchObject({ step: "reviewing", submissionId: UUID_A });
    const reviewed = reduce(state, { type: "previewLoaded", preview: PREVIEW });
    expect(reviewed).toMatchObject({ step: "review", submissionId: UUID_A, preview: PREVIEW });
  });

  it("invalidates the preview and the UUID after a semantic change", () => {
    const reviewed = reduce(
      edited(),
      { type: "requestReview", submissionId: UUID_A },
      { type: "previewLoaded", preview: PREVIEW },
      { type: "backToEdit" },
      { type: "setText", field: "name", value: "Café Nord" },
    );
    expect(reviewed.step).toBe("edit");
    const again = reduce(reviewed, { type: "requestReview", submissionId: UUID_B });
    expect(again).toMatchObject({ submissionId: UUID_B });
  });

  it("keeps the same UUID when only evidence, comment or review request change", () => {
    const state = reduce(
      edited(),
      { type: "requestReview", submissionId: UUID_A },
      { type: "previewLoaded", preview: PREVIEW },
      { type: "setEvidence", evidence: { kind: "survey" } },
      { type: "setComment", comment: COMMENT },
      { type: "setReviewRequested", value: true },
    );
    expect(state).toMatchObject({ step: "review", submissionId: UUID_A, preview: PREVIEW });
  });

  it("requires a new UUID after a failed publish attempt", () => {
    const failed = reduce(
      edited(),
      { type: "setEvidence", evidence: { kind: "survey" } },
      { type: "setComment", comment: COMMENT },
      { type: "requestReview", submissionId: UUID_A },
      { type: "previewLoaded", preview: PREVIEW },
      { type: "publish" },
      { type: "publishFailed" },
    );
    expect(failed.step).toBe("review");
    if (failed.step !== "review") return;
    expect(failed.needsNewSubmissionId).toBe(true);
    const retried = reduce(failed, { type: "publish" });
    // Publishing again is refused until a fresh id is issued.
    expect(retried.step).toBe("review");
    const withNewId = reduce(failed, { type: "newSubmissionId", submissionId: UUID_B });
    expect(withNewId).toMatchObject({ submissionId: UUID_B, needsNewSubmissionId: false });
    expect(reduce(withNewId, { type: "publish" }).step).toBe("publishing");
  });
});

describe("publish lock and success", () => {
  function readyToPublish(): OsmContributionState {
    return reduce(
      edited(),
      { type: "setEvidence", evidence: { kind: "survey" } },
      { type: "setComment", comment: COMMENT },
      { type: "requestReview", submissionId: UUID_A },
      { type: "previewLoaded", preview: PREVIEW },
    );
  }

  it("locks after the first publish so a second click cannot start another", () => {
    const publishing = reduce(readyToPublish(), { type: "publish" });
    expect(publishing).toMatchObject({ step: "publishing", submissionId: UUID_A });
    expect(reduce(publishing, { type: "publish" })).toBe(publishing);
  });

  it("refuses to publish an incomplete draft", () => {
    const incomplete = reduce(
      edited(),
      { type: "requestReview", submissionId: UUID_A },
      { type: "previewLoaded", preview: PREVIEW },
      { type: "publish" },
    );
    expect(incomplete.step).toBe("review");
  });

  it("moves to success and keeps the result", () => {
    const result = {
      ref: CONTEXT.ref,
      version: 5,
      changesetId: 77,
      changesetUrl: "https://www.openstreetmap.org/changeset/77",
      elementUrl: "https://www.openstreetmap.org/node/12",
      publishedAt: "2026-08-10T09:00:00.000Z",
    };
    const success = reduce(readyToPublish(), { type: "publish" }, { type: "published", result });
    expect(success).toEqual({ step: "success", result });
  });
});

describe("conflict", () => {
  const latest: OsmContributionContext = {
    ...CONTEXT,
    version: 6,
    fields: CONTEXT.fields.map((field) =>
      field.field === "name" && field.kind === "text"
        ? { ...field, currentValue: "Café Nord" }
        : field,
    ),
  };

  function conflicted(): OsmContributionState {
    return reduce(
      edited(),
      { type: "setEvidence", evidence: { kind: "survey" } },
      { type: "setComment", comment: COMMENT },
      { type: "requestReview", submissionId: UUID_A },
      { type: "previewLoaded", preview: PREVIEW },
      { type: "publish" },
      { type: "conflict", latest },
    );
  }

  it("retains the semantic draft and both contexts", () => {
    const state = conflicted();
    expect(state.step).toBe("conflict");
    if (state.step !== "conflict") return;
    expect(state.previous.version).toBe(4);
    expect(state.latest.version).toBe(6);
    expect(selectedChanges(state.draft)).toEqual([
      { field: "name", action: "set", value: "Café Zentral" },
    ]);
    expect(state.draft.comment).toBe(COMMENT);
  });

  it("cannot publish directly from a conflict", () => {
    const state = conflicted();
    expect(reduce(state, { type: "publish" })).toBe(state);
  });

  it("adopts the latest data only on an explicit event, with a fresh id", () => {
    const adopted = reduce(conflicted(), { type: "adoptLatest", submissionId: UUID_B });
    expect(adopted).toMatchObject({ step: "reviewing", submissionId: UUID_B });
    if (adopted.step !== "reviewing") return;
    expect(adopted.context.version).toBe(6);
    expect(selectedChanges(adopted.draft)).toEqual([
      { field: "name", action: "set", value: "Café Zentral" },
    ]);
  });

  it("marks a drafted field invalid when the latest context disables it", () => {
    const disabled: OsmContributionContext = {
      ...latest,
      fields: latest.fields.map((field) =>
        field.field === "name"
          ? { ...field, enabled: false, disabledReason: "VALUE_TOO_LONG" as const }
          : field,
      ),
    };
    const state = reduce(
      edited(),
      { type: "setEvidence", evidence: { kind: "survey" } },
      { type: "setComment", comment: COMMENT },
      { type: "requestReview", submissionId: UUID_A },
      { type: "previewLoaded", preview: PREVIEW },
      { type: "publish" },
      { type: "conflict", latest: disabled },
      { type: "adoptLatest", submissionId: UUID_B },
    );
    expect(state.step).toBe("edit");
    if (state.step !== "edit") return;
    expect(state.draft.errors.name).toBeDefined();
  });
});

describe("notes", () => {
  it("keeps note state separate with its own identity", () => {
    const state = reduce(
      initialOsmContributionState,
      { type: "open", intent: "note" },
      { type: "contextLoaded", context: CONTEXT },
      { type: "openNote" },
      { type: "setNoteText", text: "The entrance is on the other side." },
    );
    expect(state.step).toBe("note");
    if (state.step !== "note") return;
    expect(state.note.text).toBe("The entrance is on the other side.");
    expect(state.note.submissionId).toBeUndefined();

    const submitting = reduce(state, { type: "submitNote", submissionId: UUID_A });
    expect(submitting).toMatchObject({ step: "note" });
    if (submitting.step !== "note") return;
    expect(submitting.note.submissionId).toBe(UUID_A);
    expect(submitting.note.submitting).toBe(true);
    // A second click cannot start another submission.
    expect(reduce(submitting, { type: "submitNote", submissionId: UUID_B })).toBe(submitting);
  });

  it("starts with empty text and never generates a correction", () => {
    const state = reduce(
      initialOsmContributionState,
      { type: "open", intent: "note" },
      { type: "contextLoaded", context: CONTEXT },
      { type: "openNote" },
    );
    if (state.step !== "note") throw new Error("expected note");
    expect(state.note.text).toBe("");
  });

  it("has no event that turns a failed edit into a note", () => {
    const failed = reduce(
      edited(),
      { type: "setEvidence", evidence: { kind: "survey" } },
      { type: "setComment", comment: COMMENT },
      { type: "requestReview", submissionId: UUID_A },
      { type: "previewLoaded", preview: PREVIEW },
      { type: "publish" },
      { type: "publishFailed" },
    );
    expect(failed.step).toBe("review");
  });
});

describe("dirty close", () => {
  it("asks to discard only when there is unsent input", () => {
    const clean = reduce(
      initialOsmContributionState,
      { type: "open", intent: "edit" },
      { type: "contextLoaded", context: CONTEXT },
    );
    if (clean.step !== "edit") throw new Error("expected edit");
    expect(isDraftDirty(clean.draft)).toBe(false);
    expect(reduce(clean, { type: "requestClose" })).toEqual({ step: "closed" });

    const dirty = edited();
    if (dirty.step !== "edit") throw new Error("expected edit");
    expect(isDraftDirty(dirty.draft)).toBe(true);
    const confirming = reduce(dirty, { type: "requestClose" });
    expect(confirming).toMatchObject({ step: "edit", confirmingDiscard: true });
    expect(reduce(confirming, { type: "cancelDiscard" })).toMatchObject({
      confirmingDiscard: false,
    });
    expect(reduce(confirming, { type: "confirmDiscard" })).toEqual({ step: "closed" });
  });

  it("closes immediately from success", () => {
    const success: OsmContributionState = {
      step: "success",
      result: {
        noteId: 9,
        noteUrl: "https://www.openstreetmap.org/note/9",
        status: "open",
      },
    };
    expect(reduce(success, { type: "requestClose" })).toEqual({ step: "closed" });
  });
});

describe("CompleteOsmDraft", () => {
  it("narrows only when evidence and a valid comment are present", () => {
    const state = reduce(
      edited(),
      { type: "setEvidence", evidence: { kind: "survey" } },
      { type: "setComment", comment: COMMENT },
    );
    if (state.step !== "edit") throw new Error("expected edit");
    expect(isDraftComplete(state.draft)).toBe(true);
    const complete: CompleteOsmDraft = state.draft as CompleteOsmDraft;
    expect(complete.evidence).toEqual({ kind: "survey" });
  });
});
