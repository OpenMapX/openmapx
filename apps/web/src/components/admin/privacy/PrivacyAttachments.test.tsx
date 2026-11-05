import { ATTACHMENT_MAX_BYTES } from "@openmapx/core/privacy";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivacyAttachments, privacyAttachmentBase64 } from "./PrivacyAttachments";
import { privacyDetail } from "./privacyFixtures.test-support";
import { privacyJson, renderPrivacyComponent } from "./privacyTestClient.test-support";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
afterEach(() => vi.unstubAllGlobals());
describe("encrypted attachment actions", () => {
  it("requires rights-review reason and submits the fresh case version without rewriting bytes", async () => {
    const detail = privacyDetail();
    const attachment = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      purpose: "operator_supplement" as const,
      filename: "reviewed.txt",
      mediaType: "text/plain" as const,
      plaintextBytes: 1,
      expiresAt: "2030-01-01T00:00:00Z",
      rightsReviewState: "pending" as const,
      metadata: { source: "synthetic" },
    };
    detail.attachments = [attachment];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, rawInit: unknown) => {
        const init = rawInit as RequestInit | undefined;
        bodies.push(JSON.parse(String(init?.body)));
        return privacyJson({
          request: detail.request,
          attachment: { ...attachment, rightsReviewState: "approved" },
        });
      }),
    );
    renderPrivacyComponent(detail, (client) => (
      <PrivacyAttachments detail={detail} client={client} />
    ));
    const approve = screen.getByRole("button", { name: "privacyAdmin.workflows.approved" });
    expect(approve).toBeDisabled();
    fireEvent.change(screen.getByLabelText("privacyAdmin.workflows.rightsReviewReason"), {
      target: { value: "rights-reviewed" },
    });
    fireEvent.click(approve);
    await waitFor(() =>
      expect(bodies).toEqual([{ version: 3, decision: "approved", reasonCode: "rights-reviewed" }]),
    );
  });
  it("rejects oversized selection before reading or base64 conversion", async () => {
    const arrayBuffer = vi.fn();
    await expect(
      privacyAttachmentBase64({ size: ATTACHMENT_MAX_BYTES + 1, arrayBuffer } as unknown as File),
    ).rejects.toThrow("ATTACHMENT_TOO_LARGE");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
