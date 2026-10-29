import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, createTestQueryClient, fireEvent, render, screen, waitFor } from "@/test";
import { TransitCredentialsSection } from "./TransitCredentialsSection";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
  apiUrl: "http://api.test",
  actorId: "admin-a",
}));
vi.mock("@/lib/admin/accountAdmin", () => ({
  useAccountAdmin: () => ({ apiUrl: mocks.apiUrl, actorId: mocks.actorId }),
}));
vi.mock("@openmapx/core/api-admin-sdk", async () => ({
  ...(await vi.importActual<typeof import("@openmapx/core/api-admin-sdk")>(
    "@openmapx/core/api-admin-sdk",
  )),
  getAdminTransitCredentials: mocks.get,
  previewAdminTransitCredentials: mocks.preview,
  applyAdminTransitCredentials: mocks.apply,
}));
vi.mock("../users/AdminReauthenticationDialog", () => ({
  AdminReauthenticationDialog: ({
    onCompleted,
  }: {
    onCompleted: (proofs: { challengeId: string }[]) => void;
  }) => (
    <button
      type="button"
      onClick={() => onCompleted([{ challengeId: "11111111-1111-4111-8111-111111111111" }])}
    >
      Test confirmed sign-in
    </button>
  ),
}));
const reply = (data: unknown) => ({ status: 200, data, headers: new Headers() });
const view = {
  catalogRevisionId: "a".repeat(64),
  credentialsRevision: "b".repeat(64),
  configurationRevisionId: `cfg1_${"c".repeat(43)}`,
  owner: "vault",
  editable: true,
  reason: null,
  appliedCredentialsRevision: "b".repeat(64),
  pendingApplication: false,
  entries: [
    { key: "de/A", required: true, configured: true, orphaned: false },
    { key: "old/retained", required: false, configured: true, orphaned: true },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.get.mockResolvedValue(reply(view));
  mocks.apiUrl = "http://api.test";
  mocks.actorId = "admin-a";
});
afterEach(cleanup);
function mount() {
  const query = createTestQueryClient();
  const result = render(
    <QueryClientProvider client={query}>
      <TransitCredentialsSection />
    </QueryClientProvider>,
  );
  return { ...result, query };
}
it("shows key IDs and orphan/owner metadata with blank password fields", async () => {
  mount();
  expect(await screen.findByText("de/A")).toBeInTheDocument();
  expect(screen.getByText("old/retained")).toBeInTheDocument();
  expect(screen.getByText("Orphaned")).toBeInTheDocument();
  expect(screen.getByLabelText("New value for de/A")).toHaveValue("");
  expect(mocks.preview).not.toHaveBeenCalled();
});
it("clears submitted values on a failed preview and never keeps them in a query/mutation cache", async () => {
  mocks.preview.mockRejectedValue(new Error("network unavailable"));
  const { query } = mount();
  const input = await screen.findByLabelText("New value for de/A");
  fireEvent.change(input, { target: { value: "synthetic-private-ui-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Review credential changes" }));
  await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
  expect(input).toHaveValue("");
  expect(
    JSON.stringify(
      query
        .getQueryCache()
        .getAll()
        .map((entry) => entry.state.data),
    ),
  ).not.toContain("synthetic-private-ui-key");
  expect(query.getMutationCache().getAll()).toHaveLength(0);
  expect(JSON.stringify(sessionStorage)).not.toContain("synthetic-private-ui-key");
  expect(await screen.findByText(/Could not prepare credential changes/)).toBeInTheDocument();
});
it("keeps host-owned values read-only and requires explicit deletion confirmation", async () => {
  mocks.get.mockResolvedValue(
    reply({ ...view, owner: "file", editable: false, reason: "Manage the existing host file." }),
  );
  mount();
  expect(await screen.findByText("Manage the existing host file.")).toBeInTheDocument();
  expect(screen.queryByLabelText("New value for de/A")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Review credential changes" }),
  ).not.toBeInTheDocument();
});
it("does not stage deletion until its confirmation is accepted", async () => {
  mount();
  await screen.findByText("old/retained");
  const review = screen.getByRole("button", { name: "Review credential changes" });
  fireEvent.click(screen.getByRole("button", { name: "Delete old/retained" }));
  expect(review).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));
  expect((review as HTMLButtonElement).disabled).toBe(false);
  expect(mocks.apply).not.toHaveBeenCalled();
});
const reviewedReply = () =>
  reply({
    previewId: "22222222-2222-4222-8222-222222222222",
    intentFingerprint: "d".repeat(64),
    catalogRevisionId: view.catalogRevisionId,
    credentialsRevision: view.credentialsRevision,
    expectedCurrentRevisionId: view.configurationRevisionId,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    changes: [{ key: "de/A", action: "set" }],
    preservedCount: 1,
    mapBytes: 27,
  });
it("does not apply a completed proof after the observed map changes while the proof dialog is open", async () => {
  mocks.preview.mockResolvedValue(reviewedReply());
  const { query } = mount();
  fireEvent.change(await screen.findByLabelText("New value for de/A"), {
    target: { value: "synthetic-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review credential changes" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Confirm administrator sign-in and apply" }),
  );
  query.setQueryData(["admin", "transit", "credentials", mocks.apiUrl, mocks.actorId], {
    ...view,
    credentialsRevision: "e".repeat(64),
  });
  await screen.findByText(/The catalog, configuration or credentials changed/);
  fireEvent.click(screen.getByRole("button", { name: "Test confirmed sign-in" }));
  await waitFor(() => expect(mocks.apply).not.toHaveBeenCalled());
});
it("discards a late preview response when the actor changes", async () => {
  let resolve!: (value: ReturnType<typeof reviewedReply>) => void;
  mocks.preview.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const mounted = mount();
  fireEvent.change(await screen.findByLabelText("New value for de/A"), {
    target: { value: "synthetic-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review credential changes" }));
  await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
  mocks.actorId = "admin-b";
  mounted.rerender(
    <QueryClientProvider client={mounted.query}>
      <TransitCredentialsSection />
    </QueryClientProvider>,
  );
  await screen.findByLabelText("New value for de/A");
  expect((mocks.preview.mock.calls[0]![1] as { signal: AbortSignal }).signal.aborted).toBe(true);
  resolve(reviewedReply());
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Confirm administrator sign-in and apply" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByLabelText("New value for de/A")).toHaveValue("");
  expect(sessionStorage.length).toBe(0);
});
