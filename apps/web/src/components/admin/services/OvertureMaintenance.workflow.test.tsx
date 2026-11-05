/** Real UI state/queries; mocked DTOs are presentation evidence, not authority. */
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, createTestQueryClient, fireEvent, render, screen, waitFor } from "@/test";
import { OvertureMaintenance } from "./OvertureMaintenance";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  run: vi.fn(),
  register: vi.fn(),
  recovery: vi.fn(),
  busy: false,
}));
vi.mock("@/lib/admin/serviceAdminJobs", () => ({
  useServiceJobRegistration: () => mocks.register,
}));
vi.mock("@/lib/admin/useAdminMutationOwner", () => ({
  useAdminMutationOwner: () => ({ active: true }),
}));
vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => vi.fn() }));
vi.mock("../operations/adminOperationsApi", () => ({
  previewAdminOperation: mocks.preview,
  runAdminOperation: mocks.run,
}));
vi.mock("@openmapx/core/api-admin-sdk", async (original) => ({
  ...(await original<typeof import("@openmapx/core/api-admin-sdk")>()),
  getApiDataManagerOvertureStatus: async () => ({ status: 404, data: { error: "Not installed" } }),
  getApiDataManagerOvertureRecovery: mocks.recovery,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.busy = false;
  mocks.recovery.mockImplementation(async () => ({
    status: 200,
    data: {
      region: "europe/germany",
      busy: mocks.busy,
      downloadedRelease: "2026-10-21.0",
      installedRelease: "2026-10-21.0",
      osmAvailable: true,
      actions: Object.fromEntries(
        [
          "overture-pull",
          "overture-ingest",
          "overture-extract",
          "overture-conflate",
          "overture-restart",
        ].map((id) => [
          id,
          {
            allowed: !mocks.busy,
            reason: mocks.busy ? "Another Overture operation holds the workspace lease." : null,
          },
        ]),
      ),
    },
  }));
  mocks.preview.mockImplementation(async (_client, id, input) => ({
    ok: true,
    input,
    preview: [`Server-authored preview for ${id}`],
    risk: "destructive",
    confirmation: {
      title: "Confirm guarded recovery",
      message: "This changes the selected workspace.",
    },
  }));
  mocks.run.mockResolvedValue("synthetic-job-dto");
});
afterEach(cleanup);
function mount() {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <OvertureMaintenance apiUrl="http://api.test" />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("Region"), { target: { value: "europe/germany" } });
}
it.each([
  ["Restart links from scratch", true, "Restart links"],
  ["Resume links", false, "Resume"],
] as const)(
  "previews %s and submits only after explicit confirmation",
  async (label, restart, confirm) => {
    mount();
    const button = await screen.findByRole("button", { name: label });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await screen.findByText(/Server-authored preview/);
    expect(mocks.preview.mock.calls[0]?.[1]).toBe("overture-conflate");
    expect(mocks.preview.mock.calls[0]?.[2]).toEqual({ region: "europe/germany", restart });
    expect(mocks.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: confirm }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(mocks.run.mock.calls[0]?.[1]).toBe("overture-conflate");
    expect(mocks.run.mock.calls[0]?.[2]).toEqual({ region: "europe/germany", restart });
    expect(mocks.register).toHaveBeenCalledTimes(1);
  },
);
it("shows the busy lease reason and disables conflicting actions", async () => {
  mocks.busy = true;
  mount();
  await screen.findByText("Another Overture operation holds the workspace lease.");
  expect(screen.getByRole("button", { name: "Full sync" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Restart links from scratch" })).toBeDisabled();
});
it.each([
  ["Download release partition", "overture-pull"],
  ["Ingest downloaded partition", "overture-ingest"],
  ["Extract OSM features", "overture-extract"],
] as const)("confirms the fixed advanced %s action", async (label, id) => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Advanced recovery" }));
  const button = await screen.findByRole("button", { name: label });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  await screen.findByText(/Server-authored preview/);
  expect(mocks.run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Run operation" }));
  await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
  expect(mocks.run.mock.calls[0]?.[1]).toBe(id);
  expect(mocks.run.mock.calls[0]?.[2]).toEqual({ region: "europe/germany" });
});
