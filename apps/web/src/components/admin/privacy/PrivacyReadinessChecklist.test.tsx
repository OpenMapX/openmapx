// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { PrivacyReadinessChecklist } from "./PrivacyReadinessChecklist";

const report = {
  ready: false,
  checkedAt: "2026-09-05T00:00:00.000Z",
  evidenceVersion: "evidence-v1",
  checks: [
    { id: "controller-contact", status: "fail", detailCode: "controller-contact-missing" },
    { id: "future-check", status: "warning", detailCode: "future-detail" },
  ],
};

describe("PrivacyReadinessChecklist", () => {
  it("links a failed known check to the matching full-admin setup step", () => {
    render(<PrivacyReadinessChecklist readiness={report} canConfigure />);

    expect(
      screen.getByRole("link", { name: "privacySetup.readiness.checks.controller-contact.action" }),
    ).toHaveAttribute("href", "/admin/privacy-setup#operator");
    expect(screen.queryByText("controller-contact")).not.toBeInTheDocument();
  });

  it("keeps unknown implementation codes out of the primary flow", () => {
    render(<PrivacyReadinessChecklist readiness={report} canConfigure />);

    expect(screen.getByText("privacySetup.readiness.unknown.title")).toBeInTheDocument();
    expect(screen.queryByText("future-check")).not.toBeInTheDocument();

    const summary = screen.getAllByText("privacySetup.readiness.technicalDetails")[1];
    fireEvent.click(summary);
    expect(summary.closest("details")).toHaveTextContent("future-check");
    expect(summary.closest("details")).toHaveTextContent("future-detail");
  });

  it("asks a privacy operator to contact a full administrator without a redirecting link", () => {
    render(<PrivacyReadinessChecklist readiness={report} canConfigure={false} />);

    expect(screen.getByText("privacySetup.readiness.contactFullAdmin")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
