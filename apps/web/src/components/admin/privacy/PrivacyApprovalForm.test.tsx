// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://test.local" }),
}));

import { PrivacyApprovalForm } from "./PrivacyApprovalForm";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

describe("PrivacyApprovalForm", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: () => "11111111-1111-4111-8111-111111111111",
    });
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  it("requires an explicit decision and valid review window before submission", () => {
    render(<PrivacyApprovalForm evidenceVersion="evidence-v1" onRecorded={() => undefined} />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "privacySetup.approval.record" })).toBeDisabled();
  });

  it("reuses the same idempotency key when an unchanged submission is retried", async () => {
    let attempt = 0;
    fetchMock.mockImplementation(() => {
      attempt += 1;
      return Promise.resolve(
        attempt === 1
          ? new Response(JSON.stringify({ code: "IMPLEMENTATION_OWNERS_NOT_CONFIGURED" }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            })
          : new Response(JSON.stringify({ approval: { id: "approval-1" } }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            }),
      );
    });
    const onRecorded = vi.fn();
    render(
      <PrivacyApprovalForm
        evidenceVersion="evidence-v1"
        onRecorded={() => {
          onRecorded();
        }}
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "security-review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "privacySetup.approval.approve" }));
    fireEvent.change(screen.getByLabelText("privacySetup.approval.reviewedAt"), {
      target: { value: "2026-09-05T10:00" },
    });
    fireEvent.change(screen.getByLabelText("privacySetup.approval.expiresAt"), {
      target: { value: "2026-10-05T10:00" },
    });

    const submit = screen.getByRole("button", { name: "privacySetup.approval.record" });
    fireEvent.click(submit);
    await screen.findByText("privacySetup.approval.errors.implementationOwners");
    fireEvent.click(submit);

    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    const first = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(first.headers).toMatchObject({
      "Content-Type": "application/json",
      "Idempotency-Key": "11111111-1111-4111-8111-111111111111",
    });
    expect(second.headers).toMatchObject({
      "Idempotency-Key": "11111111-1111-4111-8111-111111111111",
    });
    const payload = JSON.parse(String(first.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      scope: "security-review",
      version: "evidence-v1",
      decision: "approved",
      findingsDigest: null,
    });
    expect(payload.reviewedAt).toMatch(/^2026-09-05T/);
    expect(payload.expiresAt).toMatch(/^2026-10-05T/);
    expect(payload).not.toHaveProperty("approverUserId");
  });

  it("requires a new explicit review when the evidence version changes", () => {
    const view = render(
      <PrivacyApprovalForm evidenceVersion="evidence-v1" onRecorded={() => undefined} />,
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "security-review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "privacySetup.approval.approve" }));
    fireEvent.change(screen.getByLabelText("privacySetup.approval.reviewedAt"), {
      target: { value: "2026-09-05T10:00" },
    });
    fireEvent.change(screen.getByLabelText("privacySetup.approval.expiresAt"), {
      target: { value: "2026-10-05T10:00" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "privacySetup.approval.record",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    view.rerender(
      <PrivacyApprovalForm evidenceVersion="evidence-v2" onRecorded={() => undefined} />,
    );

    expect(screen.getByRole("button", { name: "privacySetup.approval.record" })).toBeDisabled();
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.getByRole("button", { name: "privacySetup.approval.approve" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("fingerprints the external review reference locally for a rejection", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ approval: { id: "approval-1" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<PrivacyApprovalForm evidenceVersion="evidence-v1" onRecorded={() => undefined} />);
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "legal-content" },
    });
    fireEvent.click(screen.getByRole("button", { name: "privacySetup.approval.reject" }));
    fireEvent.change(screen.getByLabelText("privacySetup.approval.reviewedAt"), {
      target: { value: "2026-09-05T10:00" },
    });
    fireEvent.change(screen.getByLabelText("privacySetup.approval.expiresAt"), {
      target: { value: "2026-10-05T10:00" },
    });
    fireEvent.change(screen.getByLabelText("privacySetup.approval.reviewRecord"), {
      target: { value: "review-record-2026-09" },
    });
    fireEvent.click(screen.getByRole("button", { name: "privacySetup.approval.record" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body)) as { findingsDigest: string };
    expect(payload.findingsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(String(request.body)).not.toContain("review-record-2026-09");
  });
});
