// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "@/test";
import { ReportDialog } from "../ReportDialog";
import { useCrowdReportStore } from "../store";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/integration-api/components/LocationMinimap", () => ({
  LocationMinimap: () => null,
}));
vi.mock("@/integration-api/runtime/useFullScreenOnMobile", () => ({
  useFullScreenOnMobile: () => true,
  mobileFullScreenDialogPaperSx: {},
}));
const { submitState } = vi.hoisted(() => ({
  submitState: { mutate: vi.fn(), reset: vi.fn(), isError: false, isPending: false },
}));
vi.mock("../useCrowdReports", () => ({ useSubmitReport: () => submitState }));

describe("ReportDialog", () => {
  beforeEach(() => {
    useCrowdReportStore.getState().openDialog([13.74, 51.05]);
  });

  afterEach(() => {
    useCrowdReportStore.getState().closeDialog();
    Object.assign(submitState, { isError: false, isPending: false });
    submitState.mutate.mockReset();
    submitState.reset.mockReset();
  });

  it("submits the selected category at the chosen location", async () => {
    render(<ReportDialog />);
    await userEvent.click(screen.getByRole("button", { name: /crowdReports\.category\.jam/ }));
    await userEvent.click(screen.getByRole("button", { name: "crowdReports.submit" }));

    expect(submitState.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "congestion",
        geometry: { type: "Point", coordinates: [13.74, 51.05] },
      }),
      expect.anything(),
    );
  });

  it("shows a failed submit beside the actions, outside the scrolling form", () => {
    submitState.isError = true;
    render(<ReportDialog />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("crowdReports.submitError");
    // The form scrolls on a phone; an error at its end sits below the fold.
    expect(alert.closest(".MuiDialogContent-root")).toBeNull();
  });

  it("clears a failed submit when the dialog is cancelled", async () => {
    submitState.isError = true;
    render(<ReportDialog />);
    await userEvent.click(screen.getByRole("button", { name: "crowdReports.cancel" }));

    expect(submitState.reset).toHaveBeenCalled();
    expect(useCrowdReportStore.getState().open).toBe(false);
  });

  it("marks the submit button busy while the report is sent", () => {
    submitState.isPending = true;
    render(<ReportDialog />);

    const submit = screen.getByRole("button", { name: "crowdReports.submit" });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });
});
