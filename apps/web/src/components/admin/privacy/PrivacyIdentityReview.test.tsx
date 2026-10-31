import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivacyIdentityReview } from "./PrivacyIdentityReview";
import { privacyDetail } from "./privacyFixtures.test-support";
import { privacyJson, renderPrivacyComponent } from "./privacyTestClient.test-support";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
afterEach(() => vi.unstubAllGlobals());
describe("exceptional identity evidence review", () => {
  it("requires reasonable doubt and live identity evidence and sends only the exceptional-evidence method", async () => {
    const detail = privacyDetail();
    detail.attachments = [
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        purpose: "identity_evidence",
        filename: "identity.txt",
        mediaType: "text/plain",
        plaintextBytes: 1,
        expiresAt: "2030-01-01T00:00:00Z",
        rightsReviewState: "pending",
        metadata: {},
      },
    ];
    const calls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, rawInit: unknown) => {
        const init = rawInit as RequestInit | undefined;
        calls.push(JSON.parse(String(init?.body)));
        return privacyJson({ request: detail.request });
      }),
    );
    renderPrivacyComponent(detail, (client) => (
      <PrivacyIdentityReview detail={detail} client={client} />
    ));
    const button = screen.getByRole("button", {
      name: "privacyAdmin.workflows.recordIdentityReview",
    });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("privacyAdmin.workflows.reasonableDoubtCode"), {
      target: { value: "account-unavailable" },
    });
    fireEvent.mouseDown(screen.getByLabelText("privacyAdmin.workflows.identityEvidence"));
    fireEvent.click(await screen.findByRole("option", { name: "identity.txt" }));
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      version: 3,
      party: "subject",
      outcome: "verified",
      method: "exceptional_evidence",
      reasonableDoubtCode: "account-unavailable",
      evidenceAttachmentId: detail.attachments[0]!.id,
    });
  });
  it("shows representative authority independently from identity proof and excludes expired evidence", async () => {
    const detail = privacyDetail();
    detail.identities.push({
      party: "representative",
      state: "verified",
      method: "verified_email_challenge",
      authorityState: "pending",
      deliveryAuthorized: 0,
      verifiedAt: "2026-10-01T00:00:00Z",
    });
    detail.attachments = [
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        purpose: "identity_evidence",
        filename: "expired.txt",
        mediaType: "text/plain",
        plaintextBytes: 1,
        expiresAt: "2020-01-01T00:00:00Z",
        rightsReviewState: "pending",
        metadata: {},
      },
    ];
    renderPrivacyComponent(detail, (client) => (
      <PrivacyIdentityReview detail={detail} client={client} />
    ));
    fireEvent.mouseDown(screen.getByLabelText("privacyAdmin.workflows.party"));
    fireEvent.click(
      await screen.findByRole("option", { name: "privacyAdmin.parties.representative" }),
    );
    expect(screen.getByLabelText("privacyAdmin.workflows.authorityEvidence")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "privacyAdmin.workflows.approveAuthority" }),
    ).toBeDisabled();
    fireEvent.mouseDown(screen.getByLabelText("privacyAdmin.workflows.identityEvidence"));
    expect(screen.queryByRole("option", { name: "expired.txt" })).not.toBeInTheDocument();
  });
});
