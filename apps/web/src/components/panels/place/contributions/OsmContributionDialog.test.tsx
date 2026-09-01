import type {
  OsmContributionCapabilities,
  OsmContributionContext,
  OsmContributionPreview,
} from "@openmapx/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper } from "@/test/query";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const fullScreen = vi.fn(() => false);
vi.mock("@/integration-api/runtime/useFullScreenOnMobile", () => ({
  useFullScreenOnMobile: () => fullScreen(),
  mobileFullScreenDialogPaperSx: {},
}));

const REF = { type: "node", id: 12 } as const;

const CAPABILITIES: OsmContributionCapabilities = {
  enabled: true,
  directEditingEnabled: true,
  linked: true,
  canWriteApi: true,
  canWriteNotes: true,
  contributorTermsAgreed: true,
  activeBlock: false,
  account: {
    id: 7,
    displayName: "mapper",
    profileUrl: "https://www.openstreetmap.org/user/mapper",
  },
  requiredScopes: [],
  actions: { reauthorize: false },
};

const CONTEXT: OsmContributionContext = {
  ref: REF,
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
      kind: "address",
      field: "address",
      label: "Address",
      entries: [],
      enabled: false,
      disabledReason: "NO_ADDRESS_ON_ELEMENT",
    },
  ],
  advancedEditorUrl: "https://www.openstreetmap.org/edit?editor=id&node=12",
  elementUrl: "https://www.openstreetmap.org/node/12",
  fetchedAt: "2026-08-10T09:00:00.000Z",
};

const PREVIEW: OsmContributionPreview = {
  ref: REF,
  baseVersion: 4,
  changes: [
    { field: "name", label: "Name", action: "set", before: "Café Central", after: "Café Zentral" },
  ],
  tagDiff: {
    add: [],
    replace: [{ key: "name", from: "Café Central", to: "Café Zentral" }],
    remove: [],
  },
  warnings: [],
  requiresReview: false,
};

const state = {
  capabilities: {
    data: CAPABILITIES as OsmContributionCapabilities | undefined,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  },
  context: {
    data: CONTEXT as OsmContributionContext | undefined,
    isPending: false,
    error: null as unknown,
  },
  previewMutate: vi.fn(async () => PREVIEW),
  /** Set to make the next publish attempt fail with a specific error. */
  nextPublishError: null as unknown,
  publishMutate: vi.fn(async () => {
    const failure = state.nextPublishError;
    if (failure) {
      state.nextPublishError = null;
      throw failure;
    }
    return {
      ref: REF,
      version: 5,
      changesetId: 77,
      changesetUrl: "https://www.openstreetmap.org/changeset/77",
      elementUrl: "https://www.openstreetmap.org/node/12",
      publishedAt: "2026-08-10T09:00:00.000Z",
    };
  }),
  noteMutate: vi.fn(async () => ({
    noteId: 9,
    noteUrl: "https://www.openstreetmap.org/note/9",
    status: "open" as const,
  })),
  invalidate: vi.fn(),
};

vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core");
  return {
    ...actual,
    useOsmContributionCapabilities: () => state.capabilities,
    useOsmContributionContext: () => state.context,
    useOsmContributionCategories: () => ({ data: [], isFetching: false }),
    usePreviewOsmContribution: () => ({ mutateAsync: state.previewMutate, error: null }),
    usePublishOsmContribution: () => ({ mutateAsync: state.publishMutate, error: null }),
    useCreateOsmNote: () => ({ mutateAsync: state.noteMutate, error: null }),
    useInvalidateAfterContribution: () => state.invalidate,
  };
});

const { OsmContributionDialog } = await import("./OsmContributionDialog");

function renderDialog(onClose = vi.fn()) {
  render(<OsmContributionDialog open ref_={REF} onClose={onClose} />, {
    wrapper: createQueryWrapper(),
  });
  return onClose;
}

async function editName(value = "Café Zentral") {
  await userEvent.click(screen.getByText("Name"));
  const input = await screen.findByLabelText("Name");
  await userEvent.clear(input);
  await userEvent.type(input, value);
}

beforeEach(() => {
  vi.clearAllMocks();
  fullScreen.mockReturnValue(false);
  state.capabilities = { data: CAPABILITIES, isPending: false, isError: false, refetch: vi.fn() };
  state.context = { data: CONTEXT, isPending: false, error: null };
  state.nextPublishError = null;
});

describe("shell", () => {
  it("titles itself from the live context, not from a place record", async () => {
    renderDialog();
    expect(await screen.findByText("osmContributions.dialogTitleNamed")).not.toBeNull();
  });

  it("goes full screen on mobile", () => {
    fullScreen.mockReturnValue(true);
    renderDialog();
    expect(fullScreen).toHaveBeenCalled();
  });

  it("labels the dialog and its close control", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBe("osm-contribution-title");
    expect(screen.getByLabelText("osmContributions.close")).not.toBeNull();
  });
});

describe("chooser", () => {
  it("lists only server-provided fields and their disabled reasons", async () => {
    renderDialog();
    expect(await screen.findByText("Name")).not.toBeNull();
    expect(screen.getByText("osmContributions.disabledNoAddress")).not.toBeNull();
    expect(
      screen.getByText("Address").closest("div[role=button]")?.getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("links the advanced editor with the server-built URL", async () => {
    renderDialog();
    const link = (await screen.findByText("osmContributions.actionAdvanced")).closest("a");
    expect(link?.getAttribute("href")).toBe(CONTEXT.advancedEditorUrl);
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.getAttribute("target")).toBe("_blank");
  });
});

describe("review and publish", () => {
  it("renders the server preview, not a client-computed diff", async () => {
    renderDialog();
    await editName();
    await userEvent.click(screen.getByText("osmContributions.reviewAction"));

    expect(await screen.findByText("osmContributions.reviewChanges")).not.toBeNull();
    expect(screen.getByText("name: Café Central → Café Zentral")).not.toBeNull();
    expect(state.previewMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: REF,
        baseVersion: 4,
        changes: [{ field: "name", action: "set", value: "Café Zentral" }],
      }),
    );
  });

  it("keeps publish disabled until evidence and a valid comment exist", async () => {
    renderDialog();
    await editName();
    await userEvent.click(screen.getByText("osmContributions.reviewAction"));
    const publish = await screen.findByText("osmContributions.publish");
    expect((publish.closest("button") as HTMLButtonElement | null)?.disabled).toBe(true);

    await userEvent.click(screen.getByText("osmContributions.evidenceSurvey"));
    expect((publish.closest("button") as HTMLButtonElement | null)?.disabled).toBe(true);

    await userEvent.type(
      screen.getByLabelText("osmContributions.reviewCommentLabel"),
      "Corrected the name from the sign",
    );
    await waitFor(() =>
      expect((publish.closest("button") as HTMLButtonElement | null)?.disabled).toBe(false),
    );
  });

  it("shows the public attribution notice with the linked account", async () => {
    renderDialog();
    await editName();
    await userEvent.click(screen.getByText("osmContributions.reviewAction"));
    expect(await screen.findByText("osmContributions.publicNotice")).not.toBeNull();
  });

  it("publishes once for two rapid clicks and reuses the same identity", async () => {
    renderDialog();
    await editName();
    await userEvent.click(screen.getByText("osmContributions.reviewAction"));
    await userEvent.click(await screen.findByText("osmContributions.evidenceSurvey"));
    await userEvent.type(
      screen.getByLabelText("osmContributions.reviewCommentLabel"),
      "Corrected the name from the sign",
    );
    const publish = screen.getByText("osmContributions.publish").closest("button");
    if (!publish) throw new Error("publish button missing");
    const locked = userEvent.setup({ pointerEventsCheck: 0 });
    await locked.click(publish);
    // The second click must be a no-op: the action is already locked.
    await locked.click(publish);

    await waitFor(() => expect(state.publishMutate).toHaveBeenCalledTimes(1));
    const previewId = state.previewMutate.mock.calls[0]?.[0] as { idempotencyKey: string };
    const publishId = state.publishMutate.mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(publishId.idempotencyKey).toBe(previewId.idempotencyKey);
  });

  it("shows the success links and the propagation notice", async () => {
    renderDialog();
    await editName();
    await userEvent.click(screen.getByText("osmContributions.reviewAction"));
    await userEvent.click(await screen.findByText("osmContributions.evidenceSurvey"));
    await userEvent.type(
      screen.getByLabelText("osmContributions.reviewCommentLabel"),
      "Corrected the name from the sign",
    );
    await userEvent.click(screen.getByText("osmContributions.publish"));

    expect(await screen.findByText("osmContributions.successEditTitle")).not.toBeNull();
    expect(
      screen.getByText("osmContributions.successChangeset").closest("a")?.getAttribute("href"),
    ).toBe("https://www.openstreetmap.org/changeset/77");
    expect(screen.getByText("osmContributions.successLag")).not.toBeNull();
  });

  it("invalidates the place only when the success view is closed", async () => {
    const onClose = renderDialog();
    await editName();
    await userEvent.click(screen.getByText("osmContributions.reviewAction"));
    await userEvent.click(await screen.findByText("osmContributions.evidenceSurvey"));
    await userEvent.type(
      screen.getByLabelText("osmContributions.reviewCommentLabel"),
      "Corrected the name from the sign",
    );
    await userEvent.click(screen.getByText("osmContributions.publish"));
    await screen.findByText("osmContributions.successEditTitle");
    expect(state.invalidate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText("osmContributions.successDone"));
    expect(state.invalidate).toHaveBeenCalledWith(REF);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("retry after a failed publish", () => {
  async function reachPublish() {
    renderDialog();
    await editName();
    await userEvent.click(screen.getByText("osmContributions.reviewAction"));
    await userEvent.click(await screen.findByText("osmContributions.evidenceSurvey"));
    await userEvent.type(
      screen.getByLabelText("osmContributions.reviewCommentLabel"),
      "Corrected the name from the sign",
    );
    const button = screen.getByText("osmContributions.publish").closest("button");
    if (!button) throw new Error("publish button missing");
    return button;
  }

  it("sends a fresh idempotency key on the retry, never the failed one", async () => {
    const { OsmContributionRequestError } = await import("@openmapx/core");
    state.nextPublishError = new OsmContributionRequestError(502, {
      code: "OSM_UNAVAILABLE",
      message: "Unavailable.",
    });

    const button = await reachPublish();
    await userEvent.click(button);
    await waitFor(() => expect(state.publishMutate).toHaveBeenCalledTimes(1));

    await userEvent.click(button);
    await waitFor(() => expect(state.publishMutate).toHaveBeenCalledTimes(2));

    const first = state.publishMutate.mock.calls[0]?.[0] as { idempotencyKey: string };
    const second = state.publishMutate.mock.calls[1]?.[0] as { idempotencyKey: string };
    // Reusing the failed id would make the server replay it instead of publishing.
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(await screen.findByText("osmContributions.successEditTitle")).not.toBeNull();
  });

  it("stops showing the failure once the retry succeeds", async () => {
    const { OsmContributionRequestError } = await import("@openmapx/core");
    state.nextPublishError = new OsmContributionRequestError(502, {
      code: "OSM_UNAVAILABLE",
      message: "Unavailable.",
    });
    const button = await reachPublish();
    await userEvent.click(button);
    await waitFor(() => expect(state.publishMutate).toHaveBeenCalledTimes(1));
    await userEvent.click(button);
    await screen.findByText("osmContributions.successEditTitle");
    // The mutation object still holds the old error; the success view must not.
    expect(screen.queryByText("osmContributions.errorOsmUnavailable")).toBeNull();
  });
});

describe("conflict", () => {
  it("keeps the draft and requires an explicit review against the latest data", async () => {
    const { OsmContributionRequestError } = await import("@openmapx/core");
    const latest: OsmContributionContext = {
      ...CONTEXT,
      version: 6,
      fields: [{ ...CONTEXT.fields[0], currentValue: "Café Nord" } as never, CONTEXT.fields[1]],
    };
    state.nextPublishError = new OsmContributionRequestError(409, {
      code: "VERSION_CONFLICT",
      message: "Changed upstream.",
      context: latest,
    });

    renderDialog();
    await editName();
    await userEvent.click(screen.getByText("osmContributions.reviewAction"));
    await userEvent.click(await screen.findByText("osmContributions.evidenceSurvey"));
    await userEvent.type(
      screen.getByLabelText("osmContributions.reviewCommentLabel"),
      "Corrected the name from the sign",
    );
    await userEvent.click(screen.getByText("osmContributions.publish"));

    expect(await screen.findByText("osmContributions.conflictTitle")).not.toBeNull();
    // Publishing is impossible from here; only an explicit adoption continues.
    expect(screen.queryByText("osmContributions.publish")).toBeNull();

    await userEvent.click(screen.getByText("osmContributions.conflictAdopt"));
    await waitFor(() => expect(state.previewMutate).toHaveBeenCalledTimes(2));
    const second = state.previewMutate.mock.calls[1]?.[0] as {
      baseVersion: number;
      idempotencyKey: string;
      changes: unknown[];
    };
    expect(second.baseVersion).toBe(6);
    expect(second.changes).toEqual([{ field: "name", action: "set", value: "Café Zentral" }]);
    const first = state.previewMutate.mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});

describe("notes", () => {
  it("opens an empty note form with its public disclosure", async () => {
    renderDialog();
    await userEvent.click(await screen.findByText("osmContributions.actionClosed"));
    expect(await screen.findByText("osmContributions.noteDisclosure")).not.toBeNull();
    expect(screen.getByText("osmContributions.noteNotFeedback")).not.toBeNull();
    expect((screen.getByLabelText("osmContributions.noteLabel") as HTMLTextAreaElement).value).toBe(
      "",
    );
  });

  it("requires enough text and submits exactly once", async () => {
    renderDialog();
    await userEvent.click(await screen.findByText("osmContributions.actionMoved"));
    const submit = (await screen.findByText("osmContributions.noteSubmit")).closest("button");
    if (!submit) throw new Error("submit missing");
    expect((submit as HTMLButtonElement | null)?.disabled).toBe(true);

    await userEvent.type(
      screen.getByLabelText("osmContributions.noteLabel"),
      "The entrance is on the other side of the building.",
    );
    await waitFor(() => expect((submit as HTMLButtonElement | null)?.disabled).toBe(false));
    const locked = userEvent.setup({ pointerEventsCheck: 0 });
    await locked.click(submit);
    await locked.click(submit);
    await waitFor(() => expect(state.noteMutate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("osmContributions.successNoteTitle")).not.toBeNull();
  });

  it("disables note submission when the server found no reliable centre", async () => {
    state.context = { data: { ...CONTEXT, center: null }, isPending: false, error: null };
    renderDialog();
    await userEvent.click(await screen.findByText("osmContributions.actionSomethingElse"));
    expect(await screen.findByText("osmContributions.noteNoLocation")).not.toBeNull();
    expect(
      (
        screen
          .getByText("osmContributions.noteSubmit")
          .closest("button") as HTMLButtonElement | null
      )?.disabled,
    ).toBe(true);
  });
});

describe("notes-only permission", () => {
  it("opens the note flow when direct editing is off but notes are allowed", async () => {
    state.capabilities = {
      data: { ...CAPABILITIES, directEditingEnabled: false },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    };
    renderDialog();
    // Not a dead end: the flow lands on the note form rather than an
    // unavailable panel, because write_notes is still permitted.
    expect(await screen.findByText("osmContributions.noteDisclosure")).not.toBeNull();
    expect(screen.queryByText("osmContributions.reviewAction")).toBeNull();
  });

  it("opens the note flow when only the notes permission was granted", async () => {
    state.capabilities = {
      data: { ...CAPABILITIES, canWriteApi: false },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    };
    renderDialog();
    expect(await screen.findByText("osmContributions.noteDisclosure")).not.toBeNull();
  });

  it("still gates when neither action is permitted", async () => {
    state.capabilities = {
      data: { ...CAPABILITIES, canWriteApi: false, canWriteNotes: false },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    };
    renderDialog();
    expect(await screen.findByText("osmContributions.gateScopeAction")).not.toBeNull();
    expect(screen.queryByText("osmContributions.noteDisclosure")).toBeNull();
  });
});

describe("errors", () => {
  it("renders a translated code and never the payload text", async () => {
    const { OsmContributionRequestError } = await import("@openmapx/core");
    const leaked = "upstream-detail-should-not-render";
    state.context = {
      data: undefined,
      isPending: false,
      error: new OsmContributionRequestError(502, {
        code: "OSM_UNAVAILABLE",
        message: leaked,
      }),
    };
    renderDialog();
    expect(await screen.findByText("osmContributions.errorOsmUnavailable")).not.toBeNull();
    expect(screen.queryByText(leaked)).toBeNull();
  });

  it("offers only trusted inspection links for an ambiguous result", async () => {
    const { OsmContributionRequestError } = await import("@openmapx/core");
    state.context = {
      data: undefined,
      isPending: false,
      error: new OsmContributionRequestError(502, {
        code: "AMBIGUOUS_RESULT",
        message: "Unknown.",
        inspect: { changesetUrl: "https://www.openstreetmap.org/changeset/77" },
      }),
    };
    renderDialog();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("https://www.openstreetmap.org/changeset/77")).not.toBeNull();
  });
});
