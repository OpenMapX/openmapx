import { en } from "@openmapx/i18n";
import { usePathname } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it, vi } from "vitest";
import SystemLayout from "@/app/admin/(full-admin)/system/layout";
import {
  act,
  cleanup,
  createQueryWrapper,
  createTestQueryClient,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test";
import { adminTestHistory } from "@/test/adminNavigation";
import { AdminLayout } from "../AdminLayout";
import { job } from "../activity/__tests__/fixtures";
import { SystemMaintenance } from "./SystemMaintenance";

vi.mock(
  "next/navigation",
  async () => (await import("@/test/adminNavigation")).adminNavigationMock,
);
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://api.test" }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("retains the rejected release digest when Activity disposes the System route", async () => {
  adminTestHistory.reset("/admin/system/updates");
  let failed = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ jobId: "apply-job" });
    if (String(input).includes("/jobs/"))
      return Response.json(
        job({
          id: "apply-job",
          status: failed ? "failed" : "running",
          result: failed ? { errorCode: "host_update_required" } : null,
        }),
      );
    return Response.json({
      deployment: { maintenanceReady: true },
      release: {
        currentReleaseId: "old",
        availableReleaseId: "release",
        availableDigest: "a".repeat(64),
      },
      images: [
        {
          id: "ops-agent",
          name: "Agent",
          image: "agent",
          containerState: "running",
          runningImageId: "a",
          localImageId: "a",
          updateAvailable: false,
          status: "up-to-date",
        },
      ],
    });
  });
  function Harness() {
    const path = usePathname();
    return (
      <NextIntlClientProvider locale="en" messages={en}>
        <AdminLayout
          user={{ id: "admin", name: "Admin", email: "admin@example.test", role: "admin" }}
          selfHosted
        >
          {path.startsWith("/admin/system") ? (
            <SystemLayout>
              <SystemMaintenance section="updates" />
            </SystemLayout>
          ) : (
            <div>Activity</div>
          )}
        </AdminLayout>
      </NextIntlClientProvider>
    );
  }
  const client = createTestQueryClient();
  render(<Harness />, { wrapper: createQueryWrapper(client) });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Update OpenMapX" })).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Update OpenMapX" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Type UPDATE OPENMAPX/ }), {
    target: { value: "UPDATE OPENMAPX" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Update application" }));
  await screen.findByText("running");
  act(() => adminTestHistory.push("/admin/activity"));
  failed = true;
  await act(() => client.invalidateQueries({ queryKey: ["admin", "jobs", "detail"] }));
  act(() => adminTestHistory.push("/admin/system/updates"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Update OpenMapX" })).toBeDisabled(),
  );
  expect(screen.getByText("Host update required")).toBeInTheDocument();
  client.clear();
});
