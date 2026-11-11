// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { createQueryWrapper, render, screen, userEvent, waitFor } from "@/test";
import { ReportDialog } from "../ReportDialog";
import { useCrowdReportStore } from "../store";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/",
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));
vi.mock("@/integration-api/components/LocationMinimap", () => ({
  LocationMinimap: () => null,
}));
vi.mock("@/integration-api/runtime/useFullScreenOnMobile", () => ({
  useFullScreenOnMobile: () => true,
  mobileFullScreenDialogPaperSx: {},
}));

const { MutationErrorNotice } = await import("@/components/MutationErrorNotice");

afterEach(() => {
  useCrowdReportStore.getState().closeDialog();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

it("shows a failed submit once, in the dialog, and not again in the app's notice", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
  );
  useCrowdReportStore.getState().openDialog([13.74, 51.05]);
  const Wrapper = createQueryWrapper();
  render(
    <Wrapper>
      <ReportDialog />
      <MutationErrorNotice />
    </Wrapper>,
  );

  await userEvent.click(screen.getByRole("button", { name: /crowdReports\.category\.jam/ }));
  await userEvent.click(screen.getByRole("button", { name: "crowdReports.submit" }));

  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("crowdReports.submitError"),
  );
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.queryByText("common.actionFailed")).not.toBeInTheDocument();
});
