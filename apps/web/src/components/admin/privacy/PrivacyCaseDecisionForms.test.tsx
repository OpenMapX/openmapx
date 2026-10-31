import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PrivacyCaseDecisionForms } from "./PrivacyCaseDecisionForms";
import { privacyDetail } from "./privacyFixtures.test-support";
import { renderPrivacyComponent } from "./privacyTestClient.test-support";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
describe("case decisions", () => {
  it("shows the authoritative original deadline and requires actual notification before extending", () => {
    const detail = privacyDetail();
    renderPrivacyComponent(detail, (client) => (
      <PrivacyCaseDecisionForms detail={detail} client={client} />
    ));
    expect(
      screen.getByText(/privacyAdmin.workflows.originalDueAt.*2026-10-01/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "privacyAdmin.workflows.recordExtension" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("privacyAdmin.workflows.extensionNotifiedAt")).toHaveValue("");
  });
  it("requires explicit refusal confirmation and cancel does not mutate", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const detail = privacyDetail();
    renderPrivacyComponent(detail, (client) => (
      <PrivacyCaseDecisionForms detail={detail} client={client} />
    ));
    fireEvent.mouseDown(screen.getByLabelText("privacyAdmin.workflows.caseDecision"));
    fireEvent.click(
      await screen.findByRole("option", { name: "privacyAdmin.workflows.caseStates.refused" }),
    );
    fireEvent.change(screen.getByLabelText("privacyAdmin.workflows.decisionReason"), {
      target: { value: "scope-reviewed" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "privacyAdmin.workflows.recordCaseDecision" }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "privacyAdmin.workflows.cancel" }));
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
