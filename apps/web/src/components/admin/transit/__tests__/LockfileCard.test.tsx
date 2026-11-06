import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, createTestQueryClient, fireEvent, render, screen, waitFor } from "@/test";
import { LockfileCard } from "../LockfileCard";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  propose: vi.fn(),
  validate: vi.fn(),
  activate: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
  toast: vi.fn(),
  apiUrl: "http://api.test",
  actorId: "admin-a",
  eligible: true,
  publication: "committed",
  validationStatus: "passed",
}));
vi.mock("@/lib/admin/accountAdmin", () => ({
  useAccountAdmin: () => ({ apiUrl: mocks.apiUrl, actorId: mocks.actorId }),
}));
vi.mock("@/components/admin/shared/AdminToast", () => ({ useAdminToast: () => mocks.toast }));
vi.mock("@/components/admin/services/TransitCredentialsSection", () => ({
  TransitCredentialsSection: ({ proposalId }: { proposalId?: string }) => (
    <div>Credentials for {proposalId ?? "active"}</div>
  ),
}));
vi.mock("@openmapx/core/api-admin-sdk", async (original) => ({
  ...(await original<typeof import("@openmapx/core/api-admin-sdk")>()),
  getAdminTransitPins: mocks.get,
  proposeAdminTransitPins: mocks.propose,
  validateAdminTransitPins: mocks.validate,
  activateAdminTransitPins: mocks.activate,
  getAdminTransitPinExecution: mocks.status,
  cancelAdminTransitPinExecution: mocks.cancel,
}));
const proposalId = "00000000-0000-4000-8000-000000000001",
  validationId = "00000000-0000-4000-8000-000000000002",
  jobId = "00000000-0000-4000-8000-000000000003";
const reply = (data: unknown, status = 200) => ({ data, status, headers: new Headers() });
const proposal = {
  proposalId,
  baseGenerationId: "a".repeat(64),
  diffDigest: "d".repeat(64),
  sourcePolicyRevision: "s".repeat(64),
  pins: {
    generationId: "b".repeat(64),
    transitous: { ref: "main@proposed", submodules: { "transitland-atlas": "atlas-proposed" } },
    gbfs: { commit: "gbfs-proposed" },
  },
};
function review(selected: boolean) {
  return {
    active: {
      transitous: { ref: "main@active", submodules: { "transitland-atlas": "atlas-active" } },
      gbfs: { commit: "gbfs-active" },
    },
    catalogRevisionId: "a".repeat(64),
    allowedCountries: ["de"],
    page: {
      proposals: [
        { proposalId, transitousRef: "main@proposed", createdAt: "2026-10-23T00:00:00Z" },
      ],
      total: 1,
      nextOffset: null,
    },
    proposal: selected ? proposal : null,
    diff: selected
      ? {
          digest: proposal.diffDigest,
          rows: [
            {
              id: "feed",
              change: "changed",
              region: "de",
              source: "bus",
              fields: ["license"],
              licenseStatus: "unknown",
              before: { url: "https://old.test" },
              after: { url: "https://new.test" },
            },
          ],
          total: 1,
          offset: 0,
          nextOffset: null,
        }
      : null,
    validationInputs: {},
    validation: selected
      ? {
          status: mocks.validationStatus,
          reason: "Staging import failed",
          validationId,
          countries: ["de"],
          slot: "B",
          epoch: validationId,
          manifestHash: "e".repeat(64),
          imageDigest: "sha256:test",
          expiresAt: "2026-10-30T00:00:00Z",
        }
      : null,
    validationEligible: mocks.eligible,
    blocker: null,
    execution:
      mocks.publication === "unknown"
        ? { id: jobId, status: "interrupted", publication: "unknown", diagnostics: { tail: [] } }
        : null,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiUrl = "http://api.test";
  mocks.actorId = "admin-a";
  mocks.eligible = true;
  mocks.publication = "committed";
  mocks.validationStatus = "passed";
  mocks.get.mockImplementation(async (query) =>
    reply(
      review(
        Boolean(query && typeof query === "object" && "proposalId" in query && query.proposalId),
      ),
    ),
  );
  mocks.propose.mockResolvedValue(
    reply({ proposalId, catalogRevisionId: proposal.pins.generationId }),
  );
  mocks.validate.mockResolvedValue(reply({ jobId }, 202));
  mocks.activate.mockResolvedValue(reply({ jobId }, 202));
  mocks.status.mockResolvedValue(
    reply({
      id: jobId,
      operationKey: "retained",
      fingerprint: "f".repeat(64),
      status: "running",
      publication: "committed",
      diagnostics: { tail: [], truncated: false },
    }),
  );
});
afterEach(cleanup);
function mount() {
  const client = createTestQueryClient();
  const element = () => (
    <QueryClientProvider client={client}>
      <LockfileCard state={{} as never} />
    </QueryClientProvider>
  );
  const view = render(element());
  return { ...view, client, rerenderView: () => view.rerender(element()) };
}
async function selectProposal() {
  fireEvent.mouseDown(await screen.findByLabelText("Proposal"));
  fireEvent.click(await screen.findByRole("option", { name: /main@proposed/ }));
  await screen.findByText("Credentials for " + proposalId);
}
it("creates a paired proposal without announcing an active catalog change", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Create proposal" }));
  await waitFor(() => expect(mocks.propose).toHaveBeenCalledTimes(1));
  expect(mocks.propose.mock.calls[0]?.[0]).toEqual({ branch: "main" });
  const headers = mocks.propose.mock.calls[0]?.[1] as Record<string, string>;
  expect(headers["idempotency-key"]?.startsWith("opk")).toBe(true);
  await waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith(
      "Proposal created; active pins are unchanged",
      "success",
    ),
  );
  expect(screen.getByText("Transitous: main@active")).toBeInTheDocument();
  expect(mocks.activate).not.toHaveBeenCalled();
});
it("requires the exact diff acknowledgement and final confirmation before activation", async () => {
  mount();
  await selectProposal();
  const button = screen.getByRole("button", { name: "Activate validated pair" });
  expect(button).toBeDisabled();
  expect(screen.getByText(/license unknown/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(button);
  expect(mocks.activate).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "Activate validated pair" }).at(-1)!);
  await waitFor(() => expect(mocks.activate).toHaveBeenCalledTimes(1));
  expect(mocks.activate.mock.calls[0]?.slice(0, 2)).toEqual([
    proposalId,
    {
      validationId,
      expectedGenerationId: proposal.baseGenerationId,
      diffDigest: proposal.diffDigest,
      acknowledgeLicenseChanges: true,
    },
  ]);
  expect(mocks.toast).not.toHaveBeenCalledWith("Validated catalog pair activated", "success");
  expect(await screen.findByText(/Catalog job .*running/)).toBeInTheDocument();
});
it("blocks activation for failed evidence and unresolved publication", async () => {
  mocks.eligible = false;
  mocks.validationStatus = "failed";
  mocks.publication = "unknown";
  mount();
  await selectProposal();
  expect(screen.getByText("Staging import failed")).toBeInTheDocument();
  expect(screen.getByRole("checkbox")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Activate validated pair" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Validate inactive slot" })).toBeDisabled();
  expect(mocks.activate).not.toHaveBeenCalled();
});
it("does not cancel a remote job when its observer unmounts or the account changes", async () => {
  const view = mount();
  await selectProposal();
  fireEvent.click(screen.getByRole("button", { name: "Validate inactive slot" }));
  await screen.findByText(/Catalog job .*running/);
  mocks.actorId = "admin-b";
  view.rerenderView();
  await waitFor(() => expect(screen.queryByText(/Catalog job .*running/)).not.toBeInTheDocument());
  view.unmount();
  expect(mocks.cancel).not.toHaveBeenCalled();
});
